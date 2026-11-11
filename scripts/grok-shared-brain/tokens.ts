/**
 * Funnel client tokens for the shared-brain gate.
 *
 * Plaintext tokens are printed once by the generate command and are not
 * written to disk. The file outside the repo stores SHA-256 hashes only.
 * Comparison hashes the presented bearer and uses timingSafeEqual on the
 * digests so length and mismatch do not short-circuit on the secret.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const FUNNEL_CLIENTS = ['personal', 'business', 'hermes'] as const;
export type FunnelClientId = (typeof FUNNEL_CLIENTS)[number];

export const FUNNEL_TOKEN_PREFIX = 'gbft_';
export const DEFAULT_RATE_WINDOW_MS = 60_000;
export const DEFAULT_RATE_MAX = 60;

export interface ClientRecord {
  token_sha256: string;
  routes: string[];
  write: string[];
  read: string[];
  /** Absolute path of a gbrain grant JSON. The gate reads access_token at request time and does not copy it into this file. */
  upstream_token_file?: string;
}

export interface FunnelConfig {
  version: 1;
  funnel_enabled: boolean;
  rate_limit: { window_ms: number; max: number };
  clients: Record<string, ClientRecord>;
}

export interface GeneratedTokens {
  config: FunnelConfig;
  /** Plaintext, once. Never written to the token file. */
  plaintext: Record<FunnelClientId, string>;
}

const EXPECTED: Record<FunnelClientId, { write: string[]; read: string[] }> = {
  personal: { write: ['personal'], read: ['personal', 'shared'] },
  business: { write: ['business'], read: ['business', 'shared'] },
  hermes: { write: ['hermes'], read: ['hermes', 'shared'] },
};

export function defaultFunnelTokenPath(home = homedir()): string {
  return join(home, '.gbrain', 'serve', 'funnel-tokens.json');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time match of a presented bearer against a stored SHA-256 hex digest. */
export function tokenMatchesHash(presented: string, expectedHex: string): boolean {
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  const valid = /^[0-9a-f]{64}$/i.test(expectedHex);
  const expected = valid ? Buffer.from(expectedHex, 'hex') : Buffer.alloc(actual.length);
  return timingSafeEqual(actual, expected) && valid;
}

export function redactSecrets(line: string, extras?: string | string[]): string {
  let out = line.replace(/gbft_[A-Za-z0-9_-]+/g, '[redacted]');
  const list = typeof extras === 'string' ? [extras] : extras ?? [];
  for (const extra of list) {
    if (extra.length > 0) out = out.split(extra).join('[redacted]');
  }
  return out;
}

export function generateTokens(): GeneratedTokens {
  const plaintext = {} as Record<FunnelClientId, string>;
  const clients: Record<string, ClientRecord> = {};
  for (const id of FUNNEL_CLIENTS) {
    const token = FUNNEL_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    plaintext[id] = token;
    clients[id] = {
      token_sha256: sha256Hex(token),
      routes: ['health', 'mcp'],
      write: [...EXPECTED[id].write],
      read: [...EXPECTED[id].read],
    };
  }
  return {
    plaintext,
    config: {
      version: 1,
      funnel_enabled: false,
      rate_limit: { window_ms: DEFAULT_RATE_WINDOW_MS, max: DEFAULT_RATE_MAX },
      clients,
    },
  };
}

function sameSet(actual: string[], expected: string[]): boolean {
  if (actual.length !== expected.length) return false;
  const want = new Set(expected);
  return actual.every(item => want.has(item));
}

export function parseFunnelConfig(raw: unknown): FunnelConfig {
  if (!raw || typeof raw !== 'object') throw new Error('funnel token file must be a JSON object');
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) throw new Error('funnel token file version must be 1');
  if (typeof doc.funnel_enabled !== 'boolean') throw new Error('funnel_enabled must be a boolean');
  const rate = doc.rate_limit as Record<string, unknown> | undefined;
  if (!rate || typeof rate.window_ms !== 'number' || typeof rate.max !== 'number' || rate.max < 1 || rate.window_ms < 1) {
    throw new Error('rate_limit must set window_ms and max');
  }
  const clientsIn = doc.clients;
  if (!clientsIn || typeof clientsIn !== 'object') throw new Error('clients must be an object');
  const clients: Record<string, ClientRecord> = {};
  for (const [name, value] of Object.entries(clientsIn as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new Error(`client name refused: ${name}`);
    if (!value || typeof value !== 'object') throw new Error(`client ${name} is not an object`);
    const row = value as Record<string, unknown>;
    if (typeof row.token_sha256 !== 'string') throw new Error(`client ${name} is missing token_sha256`);
    const routes = row.routes;
    const write = row.write;
    const read = row.read;
    if (!Array.isArray(routes) || !Array.isArray(write) || !Array.isArray(read)) throw new Error(`client ${name} scopes must be arrays`);
    if (routes.some(item => typeof item !== 'string') || write.some(item => typeof item !== 'string') || read.some(item => typeof item !== 'string')) {
      throw new Error(`client ${name} scopes must be strings`);
    }
    if ((write as string[]).includes('shared')) throw new Error(`client ${name} must not write shared`);
    if (row.upstream_token_file !== undefined && (typeof row.upstream_token_file !== 'string' || !isAbsolute(row.upstream_token_file))) {
      throw new Error(`client ${name} upstream_token_file must be an absolute path`);
    }
    clients[name] = {
      token_sha256: row.token_sha256,
      routes: [...(routes as string[])],
      write: [...(write as string[])],
      read: [...(read as string[])],
      ...(typeof row.upstream_token_file === 'string' ? { upstream_token_file: row.upstream_token_file } : {}),
    };
  }
  for (const id of FUNNEL_CLIENTS) {
    const row = clients[id];
    if (!row) throw new Error(`missing client ${id}`);
    if (!sameSet(row.write, EXPECTED[id].write) || !sameSet(row.read, EXPECTED[id].read)) {
      throw new Error(`client ${id} does not match the shared-brain scope`);
    }
    if (!row.routes.includes('health') || !row.routes.includes('mcp')) {
      throw new Error(`client ${id} must be allowed health and mcp`);
    }
  }
  return {
    version: 1,
    funnel_enabled: doc.funnel_enabled,
    rate_limit: { window_ms: rate.window_ms, max: rate.max },
    clients,
  };
}

/** Point personal, business, and hermes at grant JSON files outside the repo. Does not read those files. */
export function withUpstreamTokenFiles(config: FunnelConfig, grantsDir: string, repoRoot?: string): FunnelConfig {
  if (!isAbsolute(grantsDir)) throw new Error('grants directory must be an absolute path');
  if (repoRoot && pathInside(grantsDir, repoRoot)) throw new Error('upstream token file must stay outside the repo');
  const clients: Record<string, ClientRecord> = { ...config.clients };
  for (const id of FUNNEL_CLIENTS) {
    const file = join(grantsDir, `${id}.json`);
    if (repoRoot && pathInside(file, repoRoot)) throw new Error('upstream token file must stay outside the repo');
    const record = clients[id];
    if (!record) throw new Error(`missing client ${id}`);
    clients[id] = { ...record, upstream_token_file: file };
  }
  return { ...config, clients };
}

export function configContainsPlaintext(serialized: string, plaintext: Record<string, string>): boolean {
  return Object.values(plaintext).some(token => token.length > 0 && serialized.includes(token));
}

export function repoRootFrom(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('repo root not found');
}

export function pathInside(child: string, parent: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Write hashes only, mode 0600. Refuses a destination inside the git repo. */
export function writeTokenFile(destination: string, config: FunnelConfig, repoRoot: string): void {
  if (!isAbsolute(destination)) throw new Error('token file path must be absolute');
  if (pathInside(destination, repoRoot)) throw new Error('refusing to write funnel tokens inside the repo');
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(destination), 0o700); } catch { /* the create above sets the mode when the directory is new */ }
  const fd = openSync(destination, 'w', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface AuthOk { ok: true; client: string; record: ClientRecord }
export interface AuthFail { ok: false; status: 401; error: 'unauthorized' }

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S+)\s*$/i.exec(header);
  if (!match) return null;
  return match[1] ?? null;
}

/** Check every client hash. A miss is 401. Scope is enforced later. */
export function authenticate(header: string | undefined, config: FunnelConfig): AuthOk | AuthFail {
  const token = bearerToken(header);
  if (token === null || token.length === 0) return { ok: false, status: 401, error: 'unauthorized' };
  let matched: string | null = null;
  for (const [name, record] of Object.entries(config.clients)) {
    if (tokenMatchesHash(token, record.token_sha256)) matched = name;
  }
  if (!matched) return { ok: false, status: 401, error: 'unauthorized' };
  return { ok: true, client: matched, record: config.clients[matched]! };
}
