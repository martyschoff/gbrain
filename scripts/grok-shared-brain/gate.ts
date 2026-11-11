/**
 * Loopback gate in front of gbrain serve for a public Tailscale Funnel.
 *
 * Every route requires a per-client bearer. Admin routes and writes to
 * `shared` are refused after a valid token. The process binds 127.0.0.1 and
 * does not run `tailscale`.
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { authorizeRoute, evaluateMcpBody, queryTargetsSharedWrite, routeClass } from './mcp-policy.ts';
import { authenticate, pathInside, redactSecrets, type ClientRecord, type FunnelConfig } from './tokens.ts';

export const BODY_LIMIT = 1_048_576;

export interface GateOptions {
  config: FunnelConfig;
  upstreamBaseUrl: string;
  now?: () => number;
  log?: (line: string) => void;
  rateLimit?: { windowMs: number; max: number };
  /** When set, an upstream_token_file inside this directory is refused. */
  repoRoot?: string;
}

interface Bucket { stamps: number[] }

export function assertLoopbackUpstream(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('upstream URL is not valid'); }
  if (parsed.protocol !== 'http:') throw new Error('upstream must be http on loopback');
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('upstream must be loopback');
  return parsed;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    // Read the body to completion and answer 413. Do not destroy the socket:
    // destroying it drops the connection before the client can read the status.
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
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
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', fail);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
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

function upstreamAuthorization(record: ClientRecord): { header: string | null; secret: string | null } {
  if (!record.upstream_token_file) return { header: null, secret: null };
  let parsed: { access_token?: unknown };
  try { parsed = JSON.parse(readFileSync(record.upstream_token_file, 'utf8')) as { access_token?: unknown }; }
  catch { throw Object.assign(new Error('upstream_token_unreadable'), { code: 'upstream_token_unreadable' }); }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw Object.assign(new Error('upstream_token_missing'), { code: 'upstream_token_missing' });
  }
  return { header: `Bearer ${parsed.access_token}`, secret: parsed.access_token };
}

function proxy(upstream: URL, req: IncomingMessage, body: Buffer, res: ServerResponse, authorization: string | null): void {
  const target = new URL(req.url ?? '/', upstream);
  const headers: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization' || lower === 'host' || lower === 'content-length') continue;
    headers[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  if (authorization) headers.authorization = authorization;
  headers.host = upstream.host;
  headers['content-length'] = body.length;
  const upstreamReq = httpRequest({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers,
  }, upstreamRes => {
    const out: Record<string, string | number | string[]> = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (value === undefined) continue;
      if (key.toLowerCase() === 'connection') continue;
      out[key] = value;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, out);
    upstreamRes.pipe(res);
  });
  upstreamReq.setTimeout(5_000, () => {
    upstreamReq.destroy();
    if (!res.headersSent) sendJson(res, 502, { error: 'bad_gateway' });
  });
  upstreamReq.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { error: 'bad_gateway' });
  });
  upstreamReq.end(body);
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
  return createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) {
        const code = (error as NodeJS.ErrnoException).code;
        sendJson(res, code === 'too_large' ? 413 : 400, { error: code === 'too_large' ? 'too_large' : 'bad_request' });
      }
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
    const finish = (status: number, client: string, upstreamSecret?: string | null) => {
      const extras = [secret ?? '', upstreamSecret ?? ''].filter(item => item.length > 0);
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
    const sourceHeader = typeof req.headers['x-gbrain-source'] === 'string' ? req.headers['x-gbrain-source'] : undefined;
    if (queryTargetsSharedWrite(method, url.search, sourceHeader)) {
      finish(403, auth.client);
      sendJson(res, 403, { error: 'forbidden', code: 'shared_write_forbidden' });
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, BODY_LIMIT);
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
    let authorization: string | null = null;
    let upstreamSecret: string | null = null;
    try {
      const resolved = upstreamAuthorization(auth.record);
      authorization = resolved.header;
      upstreamSecret = resolved.secret;
    } catch {
      finish(502, auth.client);
      sendJson(res, 502, { error: 'bad_gateway' });
      return;
    }
    finish(200, auth.client, upstreamSecret);
    proxy(upstream, req, body, res, authorization);
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
