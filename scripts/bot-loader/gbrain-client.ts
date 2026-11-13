import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readManifest, type Manifest } from './manifest.ts';
import { redactSecrets } from './secrets.ts';

export interface PageCounts {
  sources: Record<string, number>;
  /** Keyed by `source/bot`. */
  bots: Record<string, number>;
  /** Always the loader manifest. Live brain totals are not read. */
  via: 'pages written by the loader (manifest)';
}

export interface PutOutcome {
  /** Exit 0. A failed put and a pending put are both not ok. */
  ok: boolean;
  /** Exit 10: accepted, not committed. Retried next run. Not a failure and not counted. */
  pending: boolean;
  /** Set only when the put failed. One redacted line: exit code, then JSON code/message or a short stderr/stdout clip. */
  detail?: string;
}

export interface BrainClient {
  ensureSource(source: string, directory: string): Promise<{ ok: boolean; detail?: string }>;
  putPage(source: string, slug: string, file: string): Promise<PutOutcome>;
  counts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): Promise<PageCounts>;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (argv: string[]) => Promise<SpawnResult>;

export function putArgv(bin: string, source: string, slug: string, file: string): string[] {
  return [bin, '--source', source, 'put', slug, '--file', file, '--json'];
}

export function addSourceArgv(bin: string, source: string, directory: string): string[] {
  return [bin, 'sources', 'add', source, '--path', directory, '--name', source, '--no-federated', '--force', '--json'];
}

const ALREADY = /already registered|already exists|duplicate key/i;
const PENDING_EXIT = 10;
const CLI_SNIP = 300;

/** redactSecrets, then any long token-shaped run. Never used on a page body. */
function redactCliText(text: string): string {
  return redactSecrets(text).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asOpError(value: unknown): { code: string; message: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || record.code.trim() === '') return null;
  if (typeof record.message !== 'string') return null;
  return { code: record.code, message: record.message };
}

function parseOpError(text: string): { code: string; message: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const direct = asOpError(parseJson(trimmed));
  if (direct) return direct;
  for (const line of trimmed.split('\n')) {
    const hit = asOpError(parseJson(line.trim()));
    if (hit) return hit;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return asOpError(parseJson(trimmed.slice(start, end + 1)));
  return null;
}

/** First ~300 characters of stderr, then the same clip of stdout. */
function fallbackText(stderr: string, stdout: string): string {
  const err = oneLine(stderr, CLI_SNIP);
  const out = oneLine(stdout, CLI_SNIP);
  if (err && out) return `${err} ${out}`;
  return err || out;
}

function failureDetail(result: SpawnResult): string {
  const stdout = redactCliText(result.stdout);
  const stderr = redactCliText(result.stderr);
  const parsed = parseOpError(stdout) ?? parseOpError(stderr);
  if (parsed) {
    const code = oneLine(redactCliText(parsed.code), 80);
    const message = oneLine(redactCliText(parsed.message), CLI_SNIP);
    const body = message ? `${code}: ${message}` : code;
    return `exit ${result.code}, ${body}`;
  }
  const text = fallbackText(stderr, stdout);
  return text ? `exit ${result.code}, ${text}` : `exit ${result.code}`;
}

export function spawnGbrain(argv: string[]): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => resolvePromise({ code: 127, stdout: '', stderr: redactSecrets(error.message) }));
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: redactSecrets(Buffer.concat(err).toString('utf8')),
      });
    });
  });
}

/** Pages this loader has committed. Failed puts, pending puts, missing source files, and gone bots are excluded. */
export function manifestCounts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): PageCounts {
  const sourceCounts: Record<string, number> = {};
  const botCounts: Record<string, number> = {};
  const active = new Set(bots.map((bot) => `${bot.source}/${bot.bot}`));
  for (const source of sources) sourceCounts[source] = 0;
  for (const bot of bots) botCounts[`${bot.source}/${bot.bot}`] = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!entry.inBrain || entry.pending) continue;
    const key = `${entry.source}/${entry.bot}`;
    if (!active.has(key) || !existsSync(path)) continue;
    if (sourceCounts[entry.source] !== undefined) sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    if (botCounts[key] !== undefined) botCounts[key] = (botCounts[key] ?? 0) + 1;
  }
  return { sources: sourceCounts, bots: botCounts, via: 'pages written by the loader (manifest)' };
}

export function createGbrainClient(bin: string, spawnFn: SpawnFn = spawnGbrain): BrainClient {
  return {
    async ensureSource(source, directory) {
      const result = await spawnFn(addSourceArgv(bin, source, directory));
      if (result.code === 0) return { ok: true };
      if (ALREADY.test(result.stdout) || ALREADY.test(result.stderr)) return { ok: true };
      return { ok: false, detail: failureDetail(result) };
    },
    async putPage(source, slug, file) {
      const result = await spawnFn(putArgv(bin, source, slug, file));
      if (result.code === 0) return { ok: true, pending: false };
      if (result.code === PENDING_EXIT) return { ok: false, pending: true };
      return { ok: false, pending: false, detail: failureDetail(result) };
    },
    async counts(sources, bots, manifest) {
      // stats and list call connectEngine. Never spawn them; the manifest is the count.
      return manifestCounts(sources, bots, manifest);
    },
  };
}

export function loadManifestCounts(path: string, sources: string[], bots: { source: string; bot: string }[]): PageCounts {
  return manifestCounts(sources, bots, readManifest(path));
}
