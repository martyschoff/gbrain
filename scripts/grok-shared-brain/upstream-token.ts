/**
 * Refresh a grok-bot grant file before serve rejects its access_token.
 *
 * client_credentials tokens last 3600s and a repeat grant does not mint a new
 * access_token. This posts client_id and client_secret to the loopback
 * upstream's /token, then replaces the grant file. One refresh runs at a time
 * per file. Secrets stay in the file and on the upstream request; they are
 * not returned in errors.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fsyncDirectory } from './tokens.ts';
import type { ClientRecord } from './tokens.ts';

/** Refresh when expires_at is this close, so a call does not race the TTL. */
export const UPSTREAM_REFRESH_MARGIN_SECONDS = 60;
/** grok-bot renewable TTL when /token omits expires_in. */
export const DEFAULT_ACCESS_TTL_SECONDS = 3600;
const GRANT_FILE_MAX_BYTES = 65_536;

export class UpstreamTokenError extends Error {
  readonly status: 401 | 502;
  readonly error: 'upstream_unauthorized' | 'upstream_token_refresh_failed' | 'bad_gateway';
  constructor(status: 401 | 502, error: 'upstream_unauthorized' | 'upstream_token_refresh_failed' | 'bad_gateway') {
    super(error);
    this.name = 'UpstreamTokenError';
    this.status = status;
    this.error = error;
  }
}

export interface UpstreamAuthorization {
  header: string | null;
  secret: string | null;
  /** Values the gate log must redact. Never written to the response. */
  redactions: string[];
  /** True only when this file has client_id and client_secret, so a 401 can be retried. */
  refreshable: boolean;
}

export function accessTokenExpiring(expiresAt: number | null, nowMs: number, marginSeconds = UPSTREAM_REFRESH_MARGIN_SECONDS): boolean {
  if (expiresAt === null) return false;
  return expiresAt <= Math.floor(nowMs / 1000) + marginSeconds;
}

/** Replace a grant JSON in place: temp file in the same directory, mode 0600, fsync, rename. */
export function writePrivateJsonAtomic(path: string, value: unknown): void {
  const directory = dirname(path);
  const temporary = join(directory, `.upstream-token.${randomBytes(8).toString('hex')}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temporary); } catch { /* the temp is not the grant file */ }
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the temp is not the grant file */ }
    throw error;
  }
  fsyncDirectory(directory);
  try {
    const modeFd = openSync(path, 'r+');
    try { fchmodSync(modeFd, 0o600); } finally { closeSync(modeFd); }
  } catch { /* the temp file was created mode 0600 */ }
}

function readGrant(path: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > GRANT_FILE_MAX_BYTES) throw new UpstreamTokenError(502, 'bad_gateway');
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UpstreamTokenError(502, 'bad_gateway');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UpstreamTokenError) throw error;
    throw new UpstreamTokenError(502, 'bad_gateway');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function accessTokenOf(doc: Record<string, unknown>): string | null {
  const value = doc.access_token;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

function expiresAtOf(doc: Record<string, unknown>): number | null {
  const value = doc.expires_at;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function hasClientCredentials(doc: Record<string, unknown>): boolean {
  return typeof doc.client_id === 'string' && doc.client_id.length > 0
    && typeof doc.client_secret === 'string' && doc.client_secret.length > 0;
}

export interface UpstreamTokenOptions {
  upstream: URL;
  now: () => number;
  fetchImpl?: typeof fetch;
}

export interface UpstreamTokens {
  /** Read the grant file, refreshing first when the access token is missing or inside the margin. */
  resolve(record: ClientRecord): Promise<UpstreamAuthorization>;
  /**
   * One more exchange after serve returned 401 for `failedSecret`.
   * A newer token already in the file is reused. This does not loop by itself.
   */
  refreshAfterUnauthorized(record: ClientRecord, failedSecret: string): Promise<UpstreamAuthorization>;
}

function redactionsFrom(doc: Record<string, unknown>, extra: string[] = []): string[] {
  const values = [doc.client_secret, doc.access_token, ...extra];
  return values.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function createUpstreamTokens(options: UpstreamTokenOptions): UpstreamTokens {
  const fetchImpl = options.fetchImpl ?? fetch;
  const inflight = new Map<string, Promise<UpstreamAuthorization>>();

  const exchange = (path: string, doc: Record<string, unknown>): Promise<UpstreamAuthorization> => {
    const existing = inflight.get(path);
    if (existing) return existing;
    const job = exchangeOnce(path, doc).finally(() => {
      if (inflight.get(path) === job) inflight.delete(path);
    });
    inflight.set(path, job);
    return job;
  };

  async function exchangeOnce(path: string, doc: Record<string, unknown>): Promise<UpstreamAuthorization> {
    const clientId = doc.client_id;
    const clientSecret = doc.client_secret;
    if (typeof clientId !== 'string' || clientId.length === 0 || typeof clientSecret !== 'string' || clientSecret.length === 0) {
      throw new UpstreamTokenError(401, 'upstream_unauthorized');
    }
    const basic = doc.token_endpoint_auth_method === 'client_secret_basic';
    const formEncode = (value: string) => new URLSearchParams({ credential: value }).toString().slice('credential='.length);
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(basic ? {} : { client_id: clientId, client_secret: clientSecret }) });
    const authorization = basic ? `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64')}` : undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${options.upstream.origin}/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authorization ? { authorization } : {}) },
        body,
      });
    } catch {
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamTokenError(401, 'upstream_unauthorized');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    let payload: { access_token?: unknown; expires_in?: unknown };
    try {
      payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    } catch {
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    const minted = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (minted.length === 0 || minted.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(minted)) {
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    const expiresIn = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? Math.floor(payload.expires_in)
      : DEFAULT_ACCESS_TTL_SECONDS;
    const expiresAt = Math.floor(options.now() / 1000) + expiresIn;
    let committed: { replaced: true; doc: Record<string, unknown> } | { replaced: false; doc: Record<string, unknown> };
    try {
      committed = commitMintedToken(path, doc, minted, expiresAt);
    } catch (error) {
      if (error instanceof UpstreamTokenError) throw error;
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    if (committed.replaced) return fromReplacedFile(committed.doc);
    return { header: `Bearer ${minted}`, secret: minted, redactions: redactionsFrom(committed.doc, [minted]), refreshable: true };
  }

  /**
   * Write the minted token into the file as it is now.
   * A replaced client is left unchanged and the minted token is not used.
   */
  function commitMintedToken(
    path: string,
    mintedFor: Record<string, unknown>,
    minted: string,
    expiresAt: number,
  ): { replaced: true; doc: Record<string, unknown> } | { replaced: false; doc: Record<string, unknown> } {
    let latest: Record<string, unknown>;
    try {
      latest = readGrant(path);
    } catch {
      throw new UpstreamTokenError(502, 'upstream_token_refresh_failed');
    }
    if (latest.client_id !== mintedFor.client_id || latest.client_secret !== mintedFor.client_secret) {
      return { replaced: true, doc: latest };
    }
    const next = { ...latest, access_token: minted, expires_at: expiresAt };
    writePrivateJsonAtomic(path, next);
    return { replaced: false, doc: next };
  }

  function fromFile(doc: Record<string, unknown>): UpstreamAuthorization {
    const token = accessTokenOf(doc);
    if (!token) return { header: null, secret: null, redactions: redactionsFrom(doc), refreshable: hasClientCredentials(doc) };
    return { header: `Bearer ${token}`, secret: token, redactions: redactionsFrom(doc, [token]), refreshable: hasClientCredentials(doc) };
  }

  /** Credentials changed mid-exchange. Send the file's token, and let a 401 through. */
  function fromReplacedFile(doc: Record<string, unknown>): UpstreamAuthorization {
    const token = accessTokenOf(doc);
    if (!token) return { header: null, secret: null, redactions: redactionsFrom(doc), refreshable: false };
    return { header: `Bearer ${token}`, secret: token, redactions: redactionsFrom(doc, [token]), refreshable: false };
  }

  function current(doc: Record<string, unknown>): UpstreamAuthorization | null {
    const token = accessTokenOf(doc);
    if (!token || accessTokenExpiring(expiresAtOf(doc), options.now())) return null;
    return fromFile(doc);
  }

  return {
    async resolve(record) {
      if (!record.upstream_token_file) return { header: null, secret: null, redactions: [], refreshable: false };
      const doc = readGrant(record.upstream_token_file);
      const fresh = current(doc);
      if (fresh) return fresh;
      if (!accessTokenOf(doc) && expiresAtOf(doc) === null && !hasClientCredentials(doc)) {
        throw new UpstreamTokenError(502, 'bad_gateway');
      }
      return exchange(record.upstream_token_file, doc);
    },
    async refreshAfterUnauthorized(record, failedSecret) {
      if (!record.upstream_token_file) throw new UpstreamTokenError(401, 'upstream_unauthorized');
      const doc = readGrant(record.upstream_token_file);
      const fresh = current(doc);
      if (fresh?.secret && fresh.secret !== failedSecret) return fresh;
      return exchange(record.upstream_token_file, doc);
    },
  };
}
