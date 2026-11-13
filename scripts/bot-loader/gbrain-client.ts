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

/** Status words. Any other value after a secret key is redacted. */
const NON_SECRET_VALUE = new Set([
  'missing', 'invalid', 'expired', 'required', 'none', 'null', 'empty', 'expected', 'unset', 'undefined',
]);

/** Longest first so `authorization` wins over `auth` and `access_token` over `token`. */
const ASSIGNMENT_KEY = [
  'authorization', 'access_token', 'access-token', 'accesstoken', 'password',
  'api_key', 'api-key', 'apikey', 'bearer', 'passwd', 'secret', 'token', 'auth',
] as const;
const QUERY_KEY = [...ASSIGNMENT_KEY, 'key'] as const;

function wordChar(char: string | undefined): boolean {
  return char !== undefined && ((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_');
}

function keyAt(text: string, index: number, names: readonly string[]): { name: string; end: number } | null {
  if (wordChar(text[index - 1])) return null;
  const slice = text.slice(index, index + 16).toLowerCase();
  for (const name of names) {
    if (!slice.startsWith(name)) continue;
    const end = index + name.length;
    if (wordChar(text[end])) continue;
    return { name, end };
  }
  return null;
}

/** Index where the value begins, after `:` or `=`. Space and tab only. */
function valueStartAt(text: string, index: number): number | null {
  let cursor = index;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  if (text[cursor] !== ':' && text[cursor] !== '=') return null;
  cursor++;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  return cursor;
}

function nonSecretValue(raw: string): boolean {
  return NON_SECRET_VALUE.has(raw.toLowerCase());
}

/**
 * Quoted values keep spaces and honor backslash escapes. An unterminated quote
 * runs to the end of the line. Unquoted query values stop at whitespace, `&`,
 * or `#`. Any other unquoted value runs to whitespace.
 */
function readValue(text: string, index: number, query: boolean): { end: number; raw: string; quoted: boolean } {
  const quote = text[index];
  if (quote === '"' || quote === "'" || quote === '`') {
    let cursor = index + 1;
    while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') {
      if (text[cursor] === '\\') {
        cursor += cursor + 1 < text.length && text[cursor + 1] !== '\n' && text[cursor + 1] !== '\r' ? 2 : 1;
        continue;
      }
      if (text[cursor] === quote) return { end: cursor + 1, raw: text.slice(index, cursor + 1), quoted: true };
      cursor++;
    }
    return { end: cursor, raw: text.slice(index, cursor), quoted: true };
  }
  let cursor = index;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') break;
    if (query && (char === '&' || char === '#')) break;
    cursor++;
  }
  return { end: cursor, raw: text.slice(index, cursor), quoted: false };
}

/**
 * One left-to-right pass. `token=` / `token:` is always a key. The value is
 * kept only when it is a known non-secret word. `Authorization: Bearer <secret>`
 * keeps the scheme word and redacts the secret. Runs before redactSecrets so a
 * quoted value is not split by the shared start-of-line `\S+` patterns.
 */
function redactAssignments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const query = text[index - 1] === '?' || text[index - 1] === '&';
    const key = keyAt(text, index, query ? QUERY_KEY : ASSIGNMENT_KEY);
    const start = key ? valueStartAt(text, key.end) : null;
    if (key && start !== null) {
      const value = readValue(text, start, query);
      const schemeIntro = (key.name === 'auth' || key.name === 'authorization')
        && !value.quoted && value.raw.toLowerCase() === 'bearer';
      if (schemeIntro) {
        out += text.slice(index, start);
        index = start;
        continue;
      }
      if (!value.quoted && nonSecretValue(value.raw)) {
        out += text.slice(index, value.end);
      } else if (query) {
        out += `${text.slice(index, start)}[redacted]`;
      } else {
        out += '[redacted]';
      }
      index = value.end;
      continue;
    }
    const bearer = keyAt(text, index, ['bearer']);
    if (bearer && valueStartAt(text, bearer.end) === null && (text[bearer.end] === ' ' || text[bearer.end] === '\t')) {
      let cursor = bearer.end;
      while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
      const next = keyAt(text, cursor, ASSIGNMENT_KEY);
      const nextIsToken = next?.name === 'token' && valueStartAt(text, next.end) !== null;
      if (!nextIsToken && cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') {
        const value = readValue(text, cursor, false);
        if (value.raw && (value.quoted || !nonSecretValue(value.raw))) {
          out += 'Bearer [redacted]';
          index = value.end;
          continue;
        }
      }
    }
    out += text[index];
    index++;
  }
  return out;
}

/**
 * Redact text that may be copied onto a warning. Page files are not read here.
 * This does not stop a CLI from echoing a page, a path, or a secret, so callers
 * keep stdout off the warning and only attach a short redacted stderr line or
 * a JSON code plus message. argv is never appended.
 */
function redactCliText(text: string): string {
  let out = redactAssignments(text);
  out = redactSecrets(out);
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1');
  out = out.replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  out = out.replace(/\S+@\S+/g, '[redacted]');
  out = out.replace(/[A-Za-z]:[/\\]Users[/\\][^/\\\s]+/gi, '~');
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
