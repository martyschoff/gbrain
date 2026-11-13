import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readSync, renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isInside, writeAtomic } from './files.ts';
import type { BrainClient, PutOutcome } from './gbrain-client.ts';
import type { Manifest, ManifestEntry } from './manifest.ts';

export interface PublishInput {
  brain: BrainClient;
  source: string;
  slug: string;
  /** Path gbrain writes (`<target>/<slug>.md`). The loader does not create it. */
  canonicalPath: string;
  body: string;
  stageDir: string;
  /** Manifest entry for this origin file, when one exists. */
  prior: ManifestEntry | undefined;
  manifest: Manifest;
  warnings: string[];
  /** Outside every source. A loader-owned regular file is moved here. */
  holdDir?: string;
}

export type PublishResult =
  | { status: 'written'; revision?: string }
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'skipped' };

/**
 * Stage the page outside the source and put from that file.
 * `--force` is not used. A stored revision is sent as `--expected-revision`.
 * `revision_required` is retried once with the revision `gbrain get` returns.
 * A later conflict warns and skips; the caller counts that skip as a failure.
 * An unindexed regular file is moved aside only when this origin's manifest
 * entry names that path and no in-brain entry shares it. Nothing else is moved,
 * and the loader does not sync the source.
 */
export async function publishPage(input: PublishInput): Promise<PublishResult> {
  if (blockedOccupant(input)) {
    input.warnings.push(`put failed ${input.slug} (not a regular file)`);
    return { status: 'failed' };
  }
  const staged = join(input.stageDir, `${randomBytes(8).toString('hex')}.md`);
  writeAtomic(staged, input.body, 0o600);
  const expected = await revisionToSend(input);
  let outcome = await input.brain.putPage(input.source, input.slug, staged, expected);
  if (outcome.ok || outcome.pending) return finish(input, outcome);
  if (outcome.code === 'source_changed') {
    const recovered = await recoverOwnedFile(input, staged);
    if (recovered) return recovered;
    if (outcome.code === 'source_changed') return fail(input, outcome);
  }
  if (outcome.code === 'revision_required') {
    const rev = await readRevision(input);
    if (rev && rev !== expected) {
      outcome = await input.brain.putPage(input.source, input.slug, staged, rev);
      if (outcome.ok || outcome.pending) return finish(input, outcome);
    }
  }
  if (outcome.code === 'revision_conflict' || outcome.code === 'revision_required') {
    input.warnings.push(`put failed ${input.slug} skipped (${outcome.detail ?? `exit 1, ${outcome.code}`})`);
    return { status: 'skipped' };
  }
  return fail(input, outcome);
}

async function recoverOwnedFile(input: PublishInput, staged: string): Promise<PublishResult | null> {
  if (!ownedUnindexedFile(input)) return null;
  const held = relocateLoaderFile(input);
  if (!held) return null;
  const outcome = await input.brain.putPage(input.source, input.slug, staged, await readRevision(input));
  if (outcome.ok || outcome.pending) return finish(input, outcome);
  if (!existsSync(input.canonicalPath)) restoreHeld(held, input.canonicalPath);
  if (outcome.code === 'revision_conflict' || outcome.code === 'revision_required') {
    input.warnings.push(`put failed ${input.slug} skipped (${outcome.detail ?? `exit 1, ${outcome.code}`})`);
    return { status: 'skipped' };
  }
  return fail(input, outcome);
}

function fail(input: PublishInput, outcome: PutOutcome): PublishResult {
  input.warnings.push(`put failed ${input.slug} (${outcome.detail ?? 'exit 1'})`);
  return { status: 'failed' };
}

async function finish(input: PublishInput, outcome: PutOutcome): Promise<PublishResult> {
  if (outcome.pending) return { status: 'pending' };
  return { status: 'written', revision: outcome.revision ?? await readRevision(input) };
}

function samePage(prior: ManifestEntry, input: PublishInput): boolean {
  return prior.source === input.source
    && prior.slug === input.slug
    && resolve(prior.output) === resolve(input.canonicalPath);
}

async function revisionToSend(input: PublishInput): Promise<string | undefined> {
  const prior = input.prior;
  if (!prior?.inBrain || prior.pending || !samePage(prior, input)) return undefined;
  if (prior.revision) return prior.revision;
  return readRevision(input);
}

async function readRevision(input: PublishInput): Promise<string | undefined> {
  if (!input.brain.getRevision) return undefined;
  const read = await input.brain.getRevision(input.source, input.slug);
  return read.ok ? read.revision : undefined;
}

/**
 * This origin recorded the occupant, it is not in the brain, and no in-brain
 * entry shares the path. The occupant must be a regular file.
 */
function ownedUnindexedFile(input: PublishInput): boolean {
  const prior = input.prior;
  if (!prior || prior.inBrain === true) return false;
  if (prior.source !== input.source) return false;
  if (resolve(prior.output) !== resolve(input.canonicalPath)) return false;
  const want = resolve(input.canonicalPath);
  const shared = Object.values(input.manifest.files).some((entry) =>
    entry.inBrain === true && resolve(entry.output) === want);
  if (shared) return false;
  return regularFile(input.canonicalPath);
}

/** A non-regular occupant this origin recorded is refused before put, so a symlink is not followed. */
function blockedOccupant(input: PublishInput): boolean {
  const prior = input.prior;
  if (!prior || prior.inBrain === true || prior.source !== input.source) return false;
  if (resolve(prior.output) !== resolve(input.canonicalPath)) return false;
  try {
    return !lstatSync(input.canonicalPath).isFile();
  } catch {
    return false;
  }
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function relocateLoaderFile(input: PublishInput): string | null {
  const hold = input.holdDir;
  if (!hold || !regularFile(input.canonicalPath)) return null;
  let before: Stats;
  try { before = lstatSync(input.canonicalPath); } catch { return null; }
  if (!before.isFile()) return null;
  const dest = reserveHold(hold, input.source, input.slug);
  if (!dest) return null;
  try {
    renameSync(input.canonicalPath, dest);
    if (sameInode(dest, before)) return dest;
    if (!existsSync(input.canonicalPath)) {
      try { renameSync(dest, input.canonicalPath); } catch { /* the held copy remains */ }
    }
    return null;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') {
      dropReservation(dest);
      return null;
    }
    if (copyNoFollow(input.canonicalPath, dest, before, true)) return dest;
    dropReservation(dest);
    return null;
  }
}

function reserveHold(hold: string, source: string, slug: string): string | null {
  try {
    mkdirSync(hold, { recursive: true, mode: 0o700 });
    chmodSync(hold, 0o700);
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = attempt === 0 ? `${slug}.md` : `${slug}.${randomBytes(4).toString('hex')}.md`;
    const dest = join(hold, source, name);
    if (!isInside(hold, dest)) return null;
    try {
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      const fd = openSync(dest, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(fd);
      return dest;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

function sameInode(path: string, before: Stats): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.dev === before.dev && st.ino === before.ino;
  } catch {
    return false;
  }
}

/** Copy a regular file without following a symlink. A mismatch deletes the copy. */
function copyNoFollow(src: string, dest: string, before: Stats, destReserved: boolean): boolean {
  const flag = constants.O_NOFOLLOW ?? 0;
  let srcFd = -1;
  let destFd = -1;
  try {
    srcFd = openSync(src, constants.O_RDONLY | flag);
    const live = fstatSync(srcFd);
    if (!live.isFile() || live.dev !== before.dev || live.ino !== before.ino) return false;
    destFd = openSync(dest, (destReserved ? constants.O_WRONLY | constants.O_TRUNC : constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY) | flag, 0o600);
    const parts: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let n = 0;
    while ((n = readSync(srcFd, buf, 0, buf.length, null)) > 0) parts.push(Buffer.from(buf.subarray(0, n)));
    const body = Buffer.concat(parts);
    if (writeSync(destFd, body) !== body.length || fstatSync(destFd).size !== body.length) {
      dropReservation(dest);
      return false;
    }
    closeSync(destFd);
    destFd = -1;
    const check = openSync(dest, constants.O_RDONLY | flag);
    const got = Buffer.alloc(body.length);
    let off = 0;
    while (off < got.length) {
      const read = readSync(check, got, off, got.length - off, null);
      if (read === 0) break;
      off += read;
    }
    closeSync(check);
    if (off !== body.length || !got.equals(body)) {
      dropReservation(dest);
      return false;
    }
    const now = lstatSync(src);
    if (!now.isFile() || now.dev !== live.dev || now.ino !== live.ino) {
      dropReservation(dest);
      return false;
    }
    unlinkSync(src);
    return true;
  } catch {
    dropReservation(dest);
    return false;
  } finally {
    if (srcFd >= 0) closeQuiet(srcFd);
    if (destFd >= 0) closeQuiet(destFd);
  }
}

function restoreHeld(held: string, canonical: string): void {
  if (existsSync(canonical) || !regularFile(held)) return;
  let before: Stats;
  try { before = lstatSync(held); } catch { return; }
  mkdirSync(dirname(canonical), { recursive: true, mode: 0o700 });
  try {
    renameSync(held, canonical);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') return;
  }
  if (!copyNoFollow(held, canonical, before, false)) dropReservation(canonical);
}

function dropReservation(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

function closeQuiet(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
}

/** A directory that is not inside a source root. The staged page is removed when the run ends. */
export function openStage(targets: string[], fallbackDir: string): { dir: string; close: () => void } {
  const outside = (dir: string) => targets.every((root) => root && !isInside(root, dir) && !isInside(dir, root));
  let dir = mkdtempSync(join(tmpdir(), 'gbrain-bot-loader-'));
  if (!outside(dir)) dir = mkdtempSync(join(fallbackDir, 'gbrain-bot-loader-'));
  if (!outside(dir)) throw new Error('refusing to stage a page inside a source directory');
  return {
    dir,
    close: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* the next run does not read it */ }
    },
  };
}
