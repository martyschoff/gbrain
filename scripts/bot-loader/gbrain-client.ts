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
  /** Set only when the put failed. One redacted line: exit code or kill signal, then a JSON code and message, or one stderr line. */
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
  /** Set when the child was killed. The diagnostic names the signal instead of an exit code. */
  signal?: string | null;
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
const PIPE_CAP = 8 * 1024;

/**
 * Redact text that may be copied onto a warning. Page files are not read here.
 * This does not stop a CLI from echoing a page, a path, or a secret, so callers
 * keep stdout off the warning and only attach a short redacted stderr line or
 * a JSON code plus message. argv is never appended.
 */
function redactCliText(text: string): string {
  let out = redactSecrets(text);
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1');
  out = out.replace(/([?&](?:access_token|password|token|secret|bearer|key)=)[^&#\s]*/gi, '$1[redacted]');
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  out = out.replace(/\S+@\S+/g, '[redacted]');
  out = out.replace(/(?:\/home|\/Users)\/[^/\s]+/g, '~');
  out = out.replace(/(^|[\s"'`(])(\/(?:[^\s/]+\/)*[^\s/]+)/g, (_match, lead: string, path: string) => {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return `${lead}${base}`;
  });
  return out.replace(/[A-Za-z0-9+/=._~-]{24,}/g, '[redacted]');
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

function firstBalancedObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return parseJson(text.slice(start, i + 1));
    }
  }
  return undefined;
}

/** One JSON value: the whole text, else the first JSON line, else the first balanced object. */
function firstJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const whole = parseJson(trimmed);
  if (whole !== undefined) return whole;
  for (const line of trimmed.split('\n')) {
    const parsed = parseJson(line.trim());
    if (parsed !== undefined) return parsed;
  }
  return firstBalancedObject(trimmed);
}

function parseOpError(text: string): { code: string; message: string } | null {
  return asOpError(firstJsonValue(text));
}

function failureHead(result: SpawnResult): string {
  if (result.signal) return `killed ${result.signal}`;
  return `exit ${result.code}`;
}

function stderrLine(stderr: string): string {
  const redacted = redactCliText(stderr);
  const line = redacted.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? '';
  return oneLine(line, CLI_SNIP);
}

function failureDetail(result: SpawnResult): string {
  const head = failureHead(result);
  const parsed = parseOpError(result.stdout) ?? parseOpError(result.stderr);
  if (parsed) {
    const code = oneLine(redactCliText(parsed.code), 80);
    const message = oneLine(redactCliText(parsed.message), CLI_SNIP);
    return message ? `${head}, ${code}: ${message}` : `${head}, ${code}`;
  }
  const line = stderrLine(result.stderr);
  return line ? `${head}, ${line}` : head;
}

function pushCapped(chunks: Buffer[], state: { n: number }, chunk: Buffer): void {
  if (state.n >= PIPE_CAP) return;
  const room = PIPE_CAP - state.n;
  const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
  chunks.push(slice);
  state.n += slice.length;
}

export function spawnGbrain(argv: string[]): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    // argv is the command. It is not copied into the result or the diagnostic.
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const outBytes = { n: 0 };
    const errBytes = { n: 0 };
    child.stdout.on('data', (chunk: Buffer) => pushCapped(out, outBytes, chunk));
    child.stderr.on('data', (chunk: Buffer) => pushCapped(err, errBytes, chunk));
    child.on('error', (error) => resolvePromise({ code: 127, stdout: '', stderr: redactCliText(error.message) }));
    child.on('close', (code, signal) => {
      resolvePromise({
        code: code ?? 1,
        stdout: redactCliText(Buffer.concat(out).toString('utf8')),
        stderr: redactCliText(Buffer.concat(err).toString('utf8')),
        ...(signal ? { signal } : {}),
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
