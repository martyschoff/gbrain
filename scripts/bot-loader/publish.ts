import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
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
  prior: ManifestEntry | undefined;
  manifest: Manifest;
  warnings: string[];
  /** Runs `gbrain sync --source` at most once per source for this run. */
  syncOnce: (source: string) => Promise<boolean>;
  /** Outside every source. A loader-owned file is moved here when sync leaves it in the way. */
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
 * A page this loader already marked in the brain, with no stored revision, is
 * read with `gbrain get` and then put at that revision. A `revision_conflict`
 * warns and skips, so a page that moved is left as it is.
 * An unindexed file at a path the manifest says this loader wrote is recovered
 * without `--force` and without `--working-tree`. One `gbrain sync --source`
 * runs for that source (a plain directory imports the file; a git checkout
 * imports commits only). If the file is still there, it is moved to `holdDir`
 * and the put is retried. A cross-device move copies it, checks the bytes,
 * then unlinks the source path. The held copy stays. A file the manifest does
 * not name is left where it is.
 */
export async function publishPage(input: PublishInput): Promise<PublishResult> {
  const staged = join(input.stageDir, `${randomBytes(8).toString('hex')}.md`);
  writeAtomic(staged, input.body, 0o600);
  const expected = await revisionToSend(input);
  let outcome = await input.brain.putPage(input.source, input.slug, staged, expected);
  if (outcome.ok || outcome.pending) return finish(input, outcome);
  if (outcome.code === 'source_changed' && unindexedLoaderFile(input)) {
    const synced = await input.syncOnce(input.source);
    if (synced) {
      outcome = await input.brain.putPage(input.source, input.slug, staged, await readRevision(input));
      if (outcome.ok || outcome.pending) return finish(input, outcome);
    }
    if (outcome.code === 'source_changed' && unindexedLoaderFile(input)) {
      const held = relocateLoaderFile(input);
      if (held) {
        outcome = await input.brain.putPage(input.source, input.slug, staged, await readRevision(input));
        if (outcome.ok || outcome.pending) return finish(input, outcome);
        if (!existsSync(input.canonicalPath)) restoreHeld(held, input.canonicalPath);
      }
    }
  }
  if (outcome.code === 'revision_conflict') {
    input.warnings.push(`put ${input.slug} skipped (${outcome.detail ?? 'exit 1, revision_conflict'})`);
    return { status: 'skipped' };
  }
  input.warnings.push(`put ${input.slug} failed (${outcome.detail ?? 'exit 1'})`);
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

function relocateLoaderFile(input: PublishInput): string | null {
  const hold = input.holdDir;
  if (!hold || !existsSync(input.canonicalPath)) return null;
  const dest = uniqueHold(hold, input.source, input.slug);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    renameSync(input.canonicalPath, dest);
    return dest;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code !== 'EXDEV') return null;
    try {
      copyFileSync(input.canonicalPath, dest);
      if (!sameBytes(input.canonicalPath, dest)) return null;
      unlinkSync(input.canonicalPath);
      return dest;
    } catch {
      return null;
    }
  }
}

function uniqueHold(hold: string, source: string, slug: string): string {
  const direct = join(hold, source, `${slug}.md`);
  if (!existsSync(direct)) return direct;
  return join(hold, source, `${slug}.${randomBytes(4).toString('hex')}.md`);
}

function sameBytes(left: string, right: string): boolean {
  const a = readFileSync(left);
  const b = readFileSync(right);
  return a.length === b.length && a.equals(b);
}

function restoreHeld(held: string, canonical: string): void {
  if (existsSync(canonical) || !existsSync(held)) return;
  mkdirSync(dirname(canonical), { recursive: true });
  try {
    renameSync(held, canonical);
  } catch {
    try { copyFileSync(held, canonical); } catch { /* the held copy remains */ }
  }
}

function unindexedLoaderFile(input: PublishInput): boolean {
  if (input.prior?.inBrain) return false;
  if (!existsSync(input.canonicalPath)) return false;
  const want = resolve(input.canonicalPath);
  return Object.values(input.manifest.files).some((entry) => entry.source === input.source && resolve(entry.output) === want);
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
