/**
 * Nightly per-bot drops from one or more account roots.
 * A root is <EXPORT-ROOT>/_box-export or <EXPORT-ROOT>/_box-export-<account>.
 * Each bot folder is checked on its own. Nothing is written here.
 */
import { constants, closeSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExportRootConfig } from './config.ts';
import { deniedContentMatch, deniedNameRule, type RuleMatch } from './export-deny.ts';
import { isInside } from './files.ts';
import type { BotSummary } from './summary.ts';
import { secretContentMatch, secretNameRule } from './secrets.ts';
import { sha256 } from './render.ts';

const BOT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQUIRED = ['profile.json', 'memory.md', 'routines.md'];
const NY_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})$/;

export interface ExportPage {
  absolute: string;
  relativePosix: string;
  account: string;
  botId: string;
  botName: string;
  source: string;
  targetRoot: string;
  bytes: Buffer;
}

export interface PlannedBot {
  summary: BotSummary;
  pages: ExportPage[];
}

export interface PlannedRoot {
  account: string;
  source: string;
  targetRoot: string;
  ensureSource: boolean;
  warnings: string[];
  bots: PlannedBot[];
  active: { source: string; bot: string }[];
}

export interface PlanOptions {
  /** Called after files are verified and before the manifest is read again. */
  recheck?: (botDir: string) => void;
  maxBytes: number;
  now: Date;
  maxAgeHours: number;
}

interface ListedFile {
  size: number;
  sha256: string;
}

interface ParsedManifest {
  botName: string;
  botId: string;
  account: string;
  exportedAt: string;
  files: Record<string, ListedFile>;
}

const MANIFEST_KEYS = new Set(['version', 'bot_name', 'bot_id', 'account', 'exported_at', 'files']);
const FILE_KEYS = new Set(['size', 'sha256']);

function emptySummary(account: string, bot: string, source: string): BotSummary {
  return { id: `${account}/${bot}`, source, scanned: 0, written: 0, unchanged: 0, skipped: 0, secretsSkipped: 0, pages: 0 };
}

function readNoFollow(absolute: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True when the stamp is the America/New_York wall clock for that instant. */
export function isNewYorkExportTime(value: string): boolean {
  const match = NY_STAMP.exec(value);
  if (!match) return false;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return false;
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(when);
  const pick = (type: Intl.DateTimeFormatPartTypes) => formatted.find((part) => part.type === type)?.value ?? '';
  const offset = pick('timeZoneName').replace(/^GMT/, '');
  const wall = `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}`;
  const stated = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
  return offset === match[7] && wall === stated;
}

function allowedRel(rel: string): boolean {
  if (rel === 'profile.json' || rel === 'memory.md' || rel === 'routines.md') return true;
  if (/^skills\/[a-z0-9][a-z0-9_-]{0,63}\.md$/.test(rel)) return true;
  return /^notes\/[a-z0-9][a-z0-9._-]{0,63}\.(?:md|txt|json)$/.test(rel);
}

function classifyRel(rel: string): 'ok' | 'escape' | 'bad' {
  if (rel.length === 0 || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return 'escape';
  const parts = rel.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'escape';
  return allowedRel(rel) ? 'ok' : 'bad';
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function nameRule(rel: string): string | null {
  for (const part of rel.split('/')) {
    const rule = secretNameRule(part) ?? deniedNameRule(part);
    if (rule) return rule;
  }
  return null;
}

function textMatch(text: string): RuleMatch | null {
  return secretContentMatch(text) ?? deniedContentMatch(text);
}

function warnSecret(warnings: string[], tag: string, rel: string, hit: { rule: string; line?: number }): void {
  const safe = rel.replace(/[\r\n]/g, '?');
  const line = hit.line === undefined ? '' : ` line=${hit.line}`;
  warnings.push(`export ${tag}: secret rejected ${safe} rule=${hit.rule}${line}`);
}

/** First secret-shaped string value, skipping sha256. The label never includes the value. */
function manifestSecret(raw: string, value: unknown, cursor: { i: number }): { rule: string; line: number } | null {
  if (typeof value === 'string') {
    const detail = textMatch(value);
    const token = JSON.stringify(value);
    const at = raw.indexOf(token, cursor.i);
    if (at >= 0) cursor.i = at + token.length;
    if (!detail) return null;
    const interior = JSON.stringify(value.slice(detail.index, detail.index + Math.max(detail.length, 1))).slice(1, -1);
    const found = interior.length > 0 ? raw.indexOf(interior, at >= 0 ? at : 0) : -1;
    return { rule: detail.rule, line: lineNumberAt(raw, found >= 0 ? found : Math.max(at, 0)) };
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = manifestSecret(raw, item, cursor);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'sha256') {
        if (typeof item === 'string') {
          const token = JSON.stringify(item);
          const at = raw.indexOf(token, cursor.i);
          if (at >= 0) cursor.i = at + token.length;
        }
        continue;
      }
      const hit = manifestSecret(raw, item, cursor);
      if (hit) return hit;
    }
  }
  return null;
}

function parseManifest(raw: Buffer, folder: string, account: string): { ok: true; body: ParsedManifest } | { ok: false; reason: 'bad manifest' | 'account mismatch' | 'path escape' | 'secret'; rule?: string; line?: number } {
  const text = raw.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad manifest' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'bad manifest' };
  const row = parsed as Record<string, unknown>;
  if (Object.keys(row).some((key) => !MANIFEST_KEYS.has(key))) return { ok: false, reason: 'bad manifest' };
  if (row.version !== 1) return { ok: false, reason: 'bad manifest' };
  if (typeof row.bot_name !== 'string' || row.bot_name.trim() === '' || row.bot_name.length > 200) return { ok: false, reason: 'bad manifest' };
  if (row.bot_id !== folder || typeof row.account !== 'string') return { ok: false, reason: 'bad manifest' };
  if (typeof row.exported_at !== 'string' || !isNewYorkExportTime(row.exported_at)) return { ok: false, reason: 'bad manifest' };
  if (typeof row.files !== 'object' || row.files === null || Array.isArray(row.files)) return { ok: false, reason: 'bad manifest' };
  const files: Record<string, ListedFile> = {};
  for (const [key, value] of Object.entries(row.files as Record<string, unknown>)) {
    const kind = classifyRel(key);
    if (kind === 'escape') return { ok: false, reason: 'path escape' };
    if (kind === 'bad') return { ok: false, reason: 'bad manifest' };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'bad manifest' };
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some((key) => !FILE_KEYS.has(key))) return { ok: false, reason: 'bad manifest' };
    if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 0) return { ok: false, reason: 'bad manifest' };
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) return { ok: false, reason: 'bad manifest' };
    files[key] = { size: item.size, sha256: item.sha256 };
  }
  for (const required of REQUIRED) {
    if (!files[required]) return { ok: false, reason: 'bad manifest' };
  }
  const secret = manifestSecret(text, row, { i: 0 });
  if (secret) return { ok: false, reason: 'secret', rule: secret.rule, line: secret.line };
  if (row.account !== account) return { ok: false, reason: 'account mismatch' };
  return { ok: true, body: { botName: row.bot_name.trim(), botId: folder, account, exportedAt: row.exported_at, files } };
}

function stampFresh(value: string, now: Date, maxAgeHours: number): boolean {
  const when = Date.parse(value);
  if (Number.isNaN(when)) return false;
  const windowMs = maxAgeHours * 60 * 60 * 1000;
  const age = now.getTime() - when;
  return age <= windowMs && age >= -windowMs;
}

interface Walk {
  files: string[];
  reason: 'symlink' | 'path escape' | null;
}

function walkBot(root: string): Walk {
  const files: string[] = [];
  const walk = (dir: string, prefix: string): 'symlink' | 'path escape' | null => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return 'path escape';
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(dir, entry.name);
      if (!isInside(root, absolute)) return 'path escape';
      let info;
      try {
        info = lstatSync(absolute);
      } catch {
        return 'path escape';
      }
      if (info.isSymbolicLink()) return 'symlink';
      if (info.isDirectory()) {
        const nested = walk(absolute, rel);
        if (nested) return nested;
        continue;
      }
      if (info.isFile()) files.push(rel);
    }
    return null;
  };
  const reason = walk(root, '');
  return { files, reason };
}

function locate(root: string, rel: string): 'ok' | 'symlink' | 'missing' | 'path escape' {
  const kind = classifyRel(rel);
  if (kind === 'escape') return 'path escape';
  let current = root;
  const parts = rel.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    if (!isInside(root, current)) return 'path escape';
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return 'missing';
    }
    if (info.isSymbolicLink()) return 'symlink';
    const last = index === parts.length - 1;
    if (!last && !info.isDirectory()) return 'path escape';
    if (last && !info.isFile()) return 'path escape';
  }
  const resolved = resolve(current);
  if (!isInside(resolve(root), resolved)) return 'path escape';
  return 'ok';
}

function planBot(root: ExportRootConfig, folder: string, botDir: string, opts: PlanOptions): { planned: PlannedBot; warnings: string[] } {
  const warnings: string[] = [];
  const summary = emptySummary(root.account, folder, root.source);
  const tag = `${root.account}/${folder}`;
  const manifestPath = join(botDir, 'manifest.json');
  let manifestInfo;
  try {
    manifestInfo = lstatSync(manifestPath);
  } catch {
    warnings.push(`export ${tag}: bad manifest`);
    return { planned: { summary, pages: [] }, warnings };
  }
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) {
    warnings.push(`export ${tag}: ${manifestInfo.isSymbolicLink() ? 'symlink' : 'bad manifest'}`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const first = readNoFollow(manifestPath);
  if (!first) {
    warnings.push(`export ${tag}: symlink`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const walked = walkBot(botDir);
  if (walked.reason) {
    warnings.push(`export ${tag}: ${walked.reason}`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const named = walked.files.find((rel) => nameRule(rel));
  if (named) {
    summary.secretsSkipped += 1;
    warnSecret(warnings, tag, named, { rule: nameRule(named) ?? 'secrets.names' });
    warnings.push(`export ${tag}: secret rejected`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const parsed = parseManifest(first, folder, root.account);
  if (!parsed.ok) {
    if (parsed.reason === 'secret') {
      summary.secretsSkipped += 1;
      warnSecret(warnings, tag, 'manifest.json', { rule: parsed.rule ?? 'secrets.content', line: parsed.line });
      warnings.push(`export ${tag}: secret rejected`);
    } else {
      warnings.push(`export ${tag}: ${parsed.reason}`);
    }
    return { planned: { summary, pages: [] }, warnings };
  }
  if (!stampFresh(parsed.body.exportedAt, opts.now, opts.maxAgeHours)) {
    warnings.push(`export ${tag}: stale`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const pages: ExportPage[] = [];
  let secret = false;
  for (const [rel, meta] of Object.entries(parsed.body.files)) {
    summary.scanned += 1;
    const namedRule = nameRule(rel);
    if (namedRule) {
      secret = true;
      summary.secretsSkipped += 1;
      warnSecret(warnings, tag, rel, { rule: namedRule });
      continue;
    }
    const found = locate(botDir, rel);
    if (found === 'symlink' || found === 'path escape') {
      warnings.push(`export ${tag}: ${found}`);
      return { planned: { summary, pages: [] }, warnings };
    }
    if (found === 'missing') {
      summary.skipped += 1;
      warnings.push(`export ${tag}: missing ${rel}`);
      continue;
    }
    const absolute = join(botDir, ...rel.split('/'));
    const bytes = readNoFollow(absolute);
    if (!bytes) {
      summary.skipped += 1;
      warnings.push(`export ${tag}: symlink`);
      return { planned: { summary, pages: [] }, warnings };
    }
    const text = bytes.includes(0) ? null : bytes.toString('utf8');
    const hit = text === null ? null : textMatch(text);
    if (hit) {
      secret = true;
      summary.secretsSkipped += 1;
      warnSecret(warnings, tag, rel, { rule: hit.rule, line: hit.line });
      continue;
    }
    if (bytes.length !== meta.size) {
      summary.skipped += 1;
      warnings.push(`export ${tag}: size mismatch ${rel}`);
      continue;
    }
    if (sha256(bytes) !== meta.sha256) {
      summary.skipped += 1;
      warnings.push(`export ${tag}: hash mismatch ${rel}`);
      continue;
    }
    if (bytes.length > opts.maxBytes || text === null) {
      summary.skipped += 1;
      warnings.push(`export ${tag}: ${text === null ? 'rejected binary' : 'oversized'} ${rel}`);
      continue;
    }
    pages.push({
      absolute,
      relativePosix: rel,
      account: root.account,
      botId: folder,
      botName: parsed.body.botName,
      source: root.source,
      targetRoot: root.targetRoot,
      bytes,
    });
  }
  if (secret) {
    warnings.push(`export ${tag}: secret rejected`);
    return { planned: { summary, pages: [] }, warnings };
  }
  const unlisted = walked.files.filter((rel) => rel !== 'manifest.json' && !parsed.body.files[rel]);
  if (unlisted.length > 0) warnings.push(`export ${tag}: ignored unlisted ${unlisted.length}`);
  opts.recheck?.(botDir);
  const second = readNoFollow(manifestPath);
  if (!second || !second.equals(first)) {
    warnings.push(`export ${tag}: manifest changed`);
    return { planned: { summary, pages: [] }, warnings };
  }
  return { planned: { summary, pages }, warnings };
}

export function planExportRoots(roots: ExportRootConfig[], opts: PlanOptions): PlannedRoot[] {
  return roots.map((root) => {
    const warnings: string[] = [];
    const bots: PlannedBot[] = [];
    const active: { source: string; bot: string }[] = [];
    let info;
    try {
      info = lstatSync(root.path);
    } catch {
      warnings.push(`export ${root.account}: root missing`);
      return { account: root.account, source: root.source, targetRoot: root.targetRoot, ensureSource: root.ensureSource, warnings, bots, active };
    }
    if (info.isSymbolicLink()) {
      warnings.push(`export ${root.account}: root symlink`);
      return { account: root.account, source: root.source, targetRoot: root.targetRoot, ensureSource: root.ensureSource, warnings, bots, active };
    }
    if (!info.isDirectory()) {
      warnings.push(`export ${root.account}: root missing`);
      return { account: root.account, source: root.source, targetRoot: root.targetRoot, ensureSource: root.ensureSource, warnings, bots, active };
    }
    let entries;
    try {
      entries = readdirSync(root.path, { withFileTypes: true });
    } catch {
      warnings.push(`export ${root.account}: root missing`);
      return { account: root.account, source: root.source, targetRoot: root.targetRoot, ensureSource: root.ensureSource, warnings, bots, active };
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const botDir = join(root.path, entry.name);
      let botInfo;
      try {
        botInfo = lstatSync(botDir);
      } catch {
        continue;
      }
      if (botInfo.isSymbolicLink()) {
        warnings.push(`export ${root.account}: symlink`);
        continue;
      }
      if (!botInfo.isDirectory()) continue;
      if (!BOT_SLUG.test(entry.name)) {
        warnings.push(`export ${root.account}: bad folder name`);
        continue;
      }
      active.push({ source: root.source, bot: `${root.account}/${entry.name}` });
      const planned = planBot(root, entry.name, botDir, opts);
      warnings.push(...planned.warnings);
      bots.push(planned.planned);
    }
    return { account: root.account, source: root.source, targetRoot: root.targetRoot, ensureSource: root.ensureSource, warnings, bots, active };
  });
}
