import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { GroupConfig } from './config.ts';
import { isInside, toPosix } from './files.ts';
import { classifyScannedFile } from './scan.ts';
import { contentHasSecret, isSecretFileName } from './secrets.ts';

const STAMP_LINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;
const FINANCE_RE = /holding|holdings|brokerage|positions|portfolio|1099|tax-lot/i;
const FILE_CAP = 500;
const BYTE_CAP = 50 * 1024 * 1024;

export interface PlannedFile {
  absolute: string;
  relativePosix: string;
  outputRel: string;
  outputPath: string;
  bytes: Buffer;
  botId: string;
  inputIndex: number;
}

export type FailClosedResult =
  | { ok: true; files: PlannedFile[] }
  | { ok: false; skip: string; files: [] };

export interface FailClosedContext {
  groups: GroupConfig[];
  now: Date;
  maxBytes: number;
  maxAgeHours: number;
}

interface ListedFile {
  rel: string;
  absolute: string;
  bytes: Buffer;
}

function skip(token: string): FailClosedResult {
  return { ok: false, skip: token, files: [] };
}

function partialName(filePath: string): boolean {
  const base = basename(filePath);
  return base === '_box-export.in' || base.endsWith('.bak');
}

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function staleToken(source: string): string {
  return source === 'hermes' ? 'feed stale' : 'box-export stale';
}

function financeNamed(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  return FINANCE_RE.test(rel) || FINANCE_RE.test(base) || base.toLowerCase().endsWith('.csv');
}

function readableStamp(dir: string): { ok: true; real: string } | { ok: false; token: string } {
  if (partialName(dir)) return { ok: false, token: 'partial copy' };
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    return { ok: false, token: 'input missing' };
  }
  if (partialName(real)) return { ok: false, token: 'partial copy' };
  try {
    if (!statSync(real).isDirectory()) return { ok: false, token: 'input missing' };
    readdirSync(real);
  } catch {
    return { ok: false, token: 'input missing' };
  }
  return { ok: true, real };
}

function stampLine(real: string, source: string, now: Date, maxAgeHours: number): { ok: true; line: string } | { ok: false; token: string } {
  let text = '';
  try {
    text = readFileSync(join(real, 'EXPORTED_AT'), 'utf8');
  } catch {
    return { ok: false, token: staleToken(source) };
  }
  const first = text.split(/\r?\n/)[0]?.trim() ?? '';
  if (!STAMP_LINE.test(first)) return { ok: false, token: staleToken(source) };
  const when = Date.parse(first);
  if (Number.isNaN(when) || now.getTime() - when > maxAgeHours * 60 * 60 * 1000) {
    return { ok: false, token: staleToken(source) };
  }
  return { ok: true, line: first };
}

function safeRel(stampReal: string, rel: string): string | null {
  if (rel.length === 0 || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  const absolute = resolve(stampReal, rel);
  if (!isInside(stampReal, absolute)) return null;
  let listed;
  try { listed = lstatSync(absolute); } catch { return null; }
  if (!listed.isFile() || listed.isSymbolicLink()) return null;
  let real: string;
  try { real = realpathSync(absolute); } catch { return null; }
  if (!isInside(stampReal, real)) return null;
  return absolute;
}

interface ManifestBody {
  account: string;
  source: string;
  exportedAt: string;
  files: Record<string, string>;
  fileCount: number;
  byteCount: number;
}

function readManifest(real: string): { ok: true; body: ManifestBody } | { ok: false; token: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(real, 'MANIFEST.json'), 'utf8'));
  } catch {
    return { ok: false, token: 'unsigned' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, token: 'unsigned' };
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) return { ok: false, token: 'unsigned' };
  if (typeof row.account !== 'string' || row.account === '' || typeof row.source !== 'string' || row.source === '') {
    return { ok: false, token: 'unsigned' };
  }
  if (typeof row.exported_at !== 'string' || typeof row.file_count !== 'number' || typeof row.byte_count !== 'number') {
    return { ok: false, token: 'unsigned' };
  }
  if (!Number.isInteger(row.file_count) || !Number.isInteger(row.byte_count) || row.file_count < 0 || row.byte_count < 0) {
    return { ok: false, token: 'unsigned' };
  }
  if (typeof row.files !== 'object' || row.files === null || Array.isArray(row.files)) return { ok: false, token: 'unsigned' };
  const files: Record<string, string> = {};
  for (const [key, value] of Object.entries(row.files as Record<string, unknown>)) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) return { ok: false, token: 'unsigned' };
    files[key] = value;
  }
  return {
    ok: true,
    body: {
      account: row.account,
      source: row.source,
      exportedAt: row.exported_at,
      files,
      fileCount: row.file_count,
      byteCount: row.byte_count,
    },
  };
}

function mdRelative(relativePosix: string): string {
  const slash = relativePosix.lastIndexOf('/');
  const dir = slash >= 0 ? relativePosix.slice(0, slash + 1) : '';
  const name = slash >= 0 ? relativePosix.slice(slash + 1) : relativePosix;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${dir}${stem}.md`;
}

function owningInput(group: GroupConfig, absolute: string): { botId: string; inputIndex: number; path: string } | null {
  let best: { botId: string; inputIndex: number; path: string } | null = null;
  for (const bot of group.bots) {
    for (let index = 0; index < bot.inputs.length; index++) {
      const input = bot.inputs[index]!;
      const covered = bot.inputs.some((other, otherIndex) => otherIndex !== index
        && resolve(other.path) !== resolve(input.path)
        && isInside(other.path, input.path));
      if (covered) continue;
      if (!containsPath(input.path, absolute)) continue;
      if (!best || input.path.length > best.path.length) best = { botId: bot.id, inputIndex: index, path: input.path };
    }
  }
  return best;
}

function routeRejected(groups: GroupConfig[], group: GroupConfig, output: string): boolean {
  if (!isInside(group.targetRoot, output)) return true;
  for (const other of groups) {
    if (other.source === group.source) continue;
    if (isInside(other.targetRoot, output)) return true;
    try {
      if (realpathSync(group.targetRoot) === realpathSync(other.targetRoot)) return true;
    } catch {
      // A target that is not on disk yet has no realpath collision.
    }
    try {
      if (isInside(realpathSync(other.targetRoot), resolve(output))) return true;
    } catch {
      // The other target is not on disk yet.
    }
  }
  return false;
}

/**
 * Whole-group checks for one fail-closed feed. Returns no files when the group must be skipped.
 * Does not write.
 */
function containsPath(root: string, target: string): boolean {
  if (isInside(root, target)) return true;
  try {
    return isInside(realpathSync(root), realpathSync(target));
  } catch {
    return false;
  }
}

export function checkFailClosed(group: GroupConfig, ctx: FailClosedContext): FailClosedResult {
  if (group.bots.length === 0) return skip('no bots named');
  const stampRoot = group.stampRoot;
  if (!stampRoot) return skip('input missing');
  const opened = readableStamp(stampRoot);
  if (!opened.ok) return skip(opened.token);
  const stamped = stampLine(opened.real, group.source, ctx.now, ctx.maxAgeHours);
  if (!stamped.ok) return skip(stamped.token);
  const manifest = readManifest(opened.real);
  if (!manifest.ok) return skip(manifest.token);

  const listed: ListedFile[] = [];
  let byteCount = 0;
  for (const [rel, digest] of Object.entries(manifest.body.files)) {
    const absolute = safeRel(opened.real, rel);
    if (!absolute) return skip('hash mismatch');
    const bytes = readFileSync(absolute);
    if (digestOf(bytes) !== digest) return skip('hash mismatch');
    byteCount += bytes.length;
    listed.push({ rel, absolute, bytes });
  }
  if (manifest.body.fileCount !== listed.length || manifest.body.byteCount !== byteCount || manifest.body.exportedAt !== stamped.line) {
    return skip('unsigned');
  }
  if (listed.length > FILE_CAP || byteCount > BYTE_CAP || listed.some((file) => file.bytes.length > ctx.maxBytes)) {
    return skip('oversized');
  }

  const financeGroup = ctx.groups.some((other) => other.source === 'finance'
    && (isInside(other.targetRoot, stampRoot) || group.bots.some((bot) => bot.inputs.some((input) => isInside(other.targetRoot, input.path)))));
  if (group.source === 'finance' || group.extensions.includes('.csv') || financeGroup) return skip('finance-data');
  const inputNamed = group.bots.some((bot) => bot.inputs.some((input) => financeNamed(basename(input.path))));
  if (financeNamed(basename(stampRoot)) || listed.some((file) => financeNamed(file.rel)) || inputNamed) {
    return skip('finance-data');
  }

  const allow = new Set(group.extensions);
  const allowed: ListedFile[] = [];
  let denied = 0;
  for (const file of listed) {
    const kind = classifyScannedFile(file.rel, file.bytes, allow, ctx.maxBytes);
    if (kind === 'oversize') return skip('oversized');
    if (kind === 'denied') denied++;
    else allowed.push(file);
  }
  if (allowed.length === 0 && listed.length > 0) return skip('empty after allowlist');
  if (denied > 0) return skip('denied path in manifest');
  if (allowed.some((file) => isSecretFileName(file.rel) || contentHasSecret(file.bytes.toString('utf8')))) {
    return skip('secret-bearing');
  }
  if (manifest.body.source !== group.source || manifest.body.account !== group.account) return skip('wrong source');

  const claimed = new Map<string, Set<string>>();
  const planned: PlannedFile[] = [];
  for (const file of allowed) {
    const owner = owningInput(group, file.absolute);
    if (!owner) return skip('route');
    const relativePosix = toPosix(relative(owner.path, file.absolute));
    if (relativePosix.startsWith('..') || relativePosix.split('/').includes('..')) return skip('route');
    const relativeMd = mdRelative(relativePosix);
    const used = claimed.get(owner.botId) ?? new Set<string>();
    claimed.set(owner.botId, used);
    let outputRel = relativeMd;
    let n = 2;
    while (used.has(outputRel)) {
      outputRel = relativeMd.replace(/\.md$/, `~${n}.md`);
      n++;
    }
    used.add(outputRel);
    const outputPath = join(group.targetRoot, owner.botId, outputRel);
    if (routeRejected(ctx.groups, group, outputPath)) return skip('route');
    planned.push({
      absolute: file.absolute,
      relativePosix,
      outputRel,
      outputPath,
      bytes: file.bytes,
      botId: owner.botId,
      inputIndex: owner.inputIndex,
    });
  }
  return { ok: true, files: planned };
}
