/**
 * Loopback gate in front of gbrain serve for a public Tailscale Funnel.
 *
 * Every route requires a per-client bearer. Admin routes and writes to
 * `shared` are refused after a valid token. The process binds 127.0.0.1 and
 * does not run `tailscale`.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { authorizeRoute, evaluateMcpBody, queryTargetsSharedWrite, routeClass } from './mcp-policy.ts';
import { authenticate, pathInside, redactSecrets, type FunnelConfig } from './tokens.ts';
import { createUpstreamTokens, UpstreamTokenError, type TokenEndpointFetch, type UpstreamAuthorization } from './upstream-token.ts';

export const BODY_LIMIT = 1_048_576;
/** How long a request may take to finish sending its body before the gate answers 408. */
export const BODY_READ_TIMEOUT_MS = 10_000;

export interface GateOptions {
  config: FunnelConfig;
  upstreamBaseUrl: string;
  now?: () => number;
  log?: (line: string) => void;
  rateLimit?: { windowMs: number; max: number };
  /** When set, an upstream_token_file inside this directory is refused. */
  repoRoot?: string;
  /** Token-endpoint client. Tests inject this. Default is global fetch. */
  fetchImpl?: TokenEndpointFetch;
}

interface Bucket { stamps: number[] }

export function assertLoopbackUpstream(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('upstream URL is not valid'); }
  if (parsed.protocol !== 'http:') throw new Error('upstream must be http on loopback');
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('upstream must be loopback');
  return parsed;
}

function declaredContentLength(req: IncomingMessage): number | null {
  const raw = req.headers['content-length'];
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function readBody(req: IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = declaredContentLength(req);
    if (declared !== null && declared > limit) {
      // Do not read. A client can declare a huge length and then stall.
      reject(Object.assign(new Error('too_large'), { code: 'too_large', close: true }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(Object.assign(new Error('body_timeout'), { code: 'body_timeout' }));
    }, timeoutMs);
    // Chunked or undeclared bodies are counted as they arrive. The status is
    // sent after the client finishes, so the socket is still readable.
    req.on('data', (chunk: Buffer) => {
      if (tooLarge || settled) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) fail(Object.assign(new Error('too_large'), { code: 'too_large' }));
      else if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', fail);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers?: Record<string, string>, after?: () => void): void {
  const payload = JSON.stringify(body);
  if (after) res.once('finish', after);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

class WindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly windowMs: number, private readonly max: number, private readonly now: () => number) {}
  allow(key: string): boolean {
    const time = this.now();
    const bucket = this.buckets.get(key) ?? { stamps: [] };
    bucket.stamps = bucket.stamps.filter(stamp => time - stamp < this.windowMs);
    if (bucket.stamps.length >= this.max) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.stamps.push(time);
    this.buckets.set(key, bucket);
    return true;
  }
}

/**
 * Headers the loopback serve reads for a normal MCP call.
 * Authorization and content-length are set below from the gate, not copied.
 * X-Forwarded-Proto is omitted: Funnel terminates HTTPS, and this process only sees HTTP.
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'user-agent',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

function rejectsContentEncoding(value: string | string[] | undefined): boolean {
  if (value === undefined) return false;
  const parts = (Array.isArray(value) ? value.join(',') : value).split(',');
  return parts.some(part => {
    const token = part.trim().toLowerCase();
    return token.length > 0 && token !== 'identity';
  });
}

interface HeldUpstream {
  status: number;
  headers: Record<string, string | number | string[]>;
  body: Buffer;
}

interface ProxyResult {
  status: number;
  /** Set when `holdStatus` matched and the client has not been written yet. */
  held?: HeldUpstream;
}

function proxy(
  upstream: URL,
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  authorization: string | null,
  onStatus: (status: number) => void,
  holdStatus?: number,
): Promise<ProxyResult> {
  const target = new URL(req.url ?? '/', upstream);
  const headers: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (!FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (authorization) headers.authorization = authorization;
  headers.host = upstream.host;
  headers['content-length'] = body.length;
  // Nothing here is logged, including authorization. A down upstream is 502.
  // The caller may invoke this a second time after one upstream 401.
  return new Promise(resolvePromise => {
    let settled = false;
    let onClientGone = () => {};
    let onClientClose = () => {};
    const settle = (result: ProxyResult) => {
      if (settled) return;
      settled = true;
      req.removeListener('aborted', onClientGone);
      res.removeListener('close', onClientClose);
      resolvePromise(result);
    };
    let reported = false;
    const report = (status: number) => {
      if (reported) return;
      reported = true;
      onStatus(status);
    };
    const fail = (status: number) => {
      if (res.headersSent) {
        settle({ status });
        return;
      }
      report(status);
      sendJson(res, status, { error: 'bad_gateway' });
      settle({ status });
    };
    let clientGone = false;
    const upstreamReq = httpRequest({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    }, upstreamRes => {
      const status = upstreamRes.statusCode ?? 502;
      const out: Record<string, string | number | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === 'connection') continue;
        out[key] = value;
      }
      if (holdStatus !== undefined && status === holdStatus) {
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        upstreamRes.on('data', (chunk: Buffer) => {
          if (overflow) return;
          size += chunk.length;
          if (size > BODY_LIMIT) {
            overflow = true;
            chunks.length = 0;
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on('end', () => {
          if (clientGone || res.headersSent || res.writableEnded) {
            settle({ status });
            return;
          }
          if (overflow) {
            fail(502);
            return;
          }
          settle({ status, held: { status, headers: out, body: Buffer.concat(chunks) } });
        });
        upstreamRes.on('error', () => {
          if (!clientGone) fail(502);
          else settle({ status: 502 });
        });
        return;
      }
      report(status);
      if (!res.headersSent) res.writeHead(status, out);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => settle({ status }));
      upstreamRes.on('error', () => settle({ status }));
    });
    // Five seconds covers connect and the response headers only. MCP SSE stays
    // open and can be quiet for longer than that; leaving the timer on would
    // cut the body. Drop the timer and its listener once headers arrive, the
    // upstream errors, or the client aborts or closes, so it cannot fire later.
    const onTimeout = () => {
      upstreamReq.destroy();
      fail(502);
    };
    upstreamReq.setTimeout(5_000, onTimeout);
    const disarm = () => {
      upstreamReq.setTimeout(0);
      upstreamReq.removeListener('timeout', onTimeout);
    };
    onClientGone = () => {
      if (clientGone) return;
      clientGone = true;
      disarm();
      if (!res.writableFinished) upstreamReq.destroy();
      settle({ status: 499 });
    };
    onClientClose = () => {
      disarm();
      if (!res.writableFinished) onClientGone();
    };
    upstreamReq.on('response', disarm);
    upstreamReq.on('error', () => {
      disarm();
      if (!clientGone) fail(502);
      else settle({ status: 502 });
    });
    req.on('aborted', onClientGone);
    res.on('close', onClientClose);
    upstreamReq.end(body);
  });
}

export function createFunnelGate(options: GateOptions): Server {
  const upstream = assertLoopbackUpstream(options.upstreamBaseUrl);
  if (options.repoRoot) {
    for (const record of Object.values(options.config.clients)) {
      if (record.upstream_token_file && pathInside(record.upstream_token_file, options.repoRoot)) {
        throw new Error('upstream token file must stay outside the repo');
      }
    }
  }
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const rate = options.rateLimit ?? {
    windowMs: options.config.rate_limit.window_ms,
    max: options.config.rate_limit.max,
  };
  const limiter = new WindowLimiter(rate.windowMs, rate.max, now);
  const upstreamTokens = createUpstreamTokens({ upstream, now, fetchImpl: options.fetchImpl });
  return createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) return;
      const coded = error as NodeJS.ErrnoException & { close?: boolean };
      if (coded.code === 'too_large') {
        sendJson(res, 413, { error: 'too_large' }, coded.close ? { connection: 'close' } : undefined, coded.close ? () => req.destroy() : undefined);
        return;
      }
      if (coded.code === 'body_timeout') {
        sendJson(res, 408, { error: 'request_timeout' }, { connection: 'close' }, () => req.destroy());
        return;
      }
      sendJson(res, 400, { error: 'bad_request' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = routeClass(url.pathname);
    const header = req.headers.authorization;
    const presented = typeof header === 'string' ? header : undefined;
    const auth = authenticate(presented, options.config);
    const secret = presented?.replace(/^Bearer\s+/i, '').trim();
    const hidden = [presented ?? '', secret ?? ''].filter(item => item.length > 0);
    const finish = (status: number, client: string, upstreamSecret?: string | null) => {
      const extras = upstreamSecret ? [...hidden, upstreamSecret] : [...hidden];
      log(redactSecrets(`${method} ${url.pathname} client=${client} status=${status}`, extras));
    };
    if (!auth.ok) {
      finish(401, '-');
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (!limiter.allow(auth.client)) {
      finish(429, auth.client);
      res.setHeader('retry-after', String(Math.ceil(rate.windowMs / 1000)));
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }
    const routeDecision = authorizeRoute(route, auth.record);
    if (!routeDecision.ok) {
      finish(routeDecision.status, auth.client);
      sendJson(res, routeDecision.status, { error: routeDecision.error, code: routeDecision.code });
      return;
    }
    if (rejectsContentEncoding(req.headers['content-encoding'])) {
      finish(415, auth.client);
      sendJson(res, 415, { error: 'unsupported_content_encoding' });
      return;
    }
    const sourceHeader = typeof req.headers['x-gbrain-source'] === 'string' ? req.headers['x-gbrain-source'] : undefined;
    if (queryTargetsSharedWrite(method, url.search, sourceHeader)) {
      finish(403, auth.client);
      sendJson(res, 403, { error: 'forbidden', code: 'shared_write_forbidden' });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, BODY_LIMIT, BODY_READ_TIMEOUT_MS);
    if (route === 'mcp' && method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
      if (body.length === 0) {
        finish(400, auth.client);
        sendJson(res, 400, { error: 'bad_json' });
        return;
      }
      const decision = evaluateMcpBody(body.toString('utf8'), auth.record);
      if (!decision.ok) {
        finish(decision.status, auth.client);
        if (decision.status === 400) sendJson(res, 400, { error: 'bad_json' });
        else sendJson(res, decision.status, { error: decision.error, code: decision.code });
        return;
      }
    }
    const sendTokenError = (error: unknown) => {
      if (res.headersSent) return;
      if (error instanceof UpstreamTokenError) {
        finish(error.status, auth.client);
        sendJson(res, error.status, { error: error.error });
        return;
      }
      finish(502, auth.client);
      sendJson(res, 502, { error: 'bad_gateway' });
    };
    let authz: UpstreamAuthorization;
    try {
      authz = await upstreamTokens.resolve(auth.record);
    } catch (error) {
      sendTokenError(error);
      return;
    }
    hidden.push(...authz.redactions);
    const canRefresh = authz.refreshable;
    const first = await proxy(
      upstream, req, body, res, authz.header,
      status => finish(status, auth.client, authz.secret),
      canRefresh ? 401 : undefined,
    );
    if (!first.held || res.headersSent || res.writableEnded) return;
    try {
      authz = await upstreamTokens.refreshAfterUnauthorized(auth.record, authz.secret ?? '');
    } catch (error) {
      sendTokenError(error);
      return;
    }
    hidden.push(...authz.redactions);
    await proxy(upstream, req, body, res, authz.header, status => finish(status, auth.client, authz.secret));
  }
}

export function listenGate(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1') {
        reject(new Error('gate must bind 127.0.0.1'));
        return;
      }
      resolve(address.port);
    });
  });
}
