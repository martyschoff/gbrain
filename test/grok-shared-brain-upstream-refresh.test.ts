/**
 * The funnel gate refreshes a grok-bot grant before expires_at and once after
 * an upstream 401. Listeners bind 127.0.0.1. Tokens here are fixtures.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createFunnelGate, listenGate } from '../scripts/grok-shared-brain/gate.ts';
import { generateTokens, repoRootFrom, type FunnelConfig } from '../scripts/grok-shared-brain/tokens.ts';
import { UPSTREAM_REFRESH_MARGIN_SECONDS, writePrivateJsonAtomic } from '../scripts/grok-shared-brain/upstream-token.ts';

const CLIENT_SECRET = 'client-secret-do-not-log';
const STALE_TOKEN = 'stale-access-token-do-not-log';
const MINTED_TOKEN = 'minted-access-token-do-not-log';
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = 1_700_000_000;

function call(port: number, token: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, connection: 'close' },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function gateConfig(path: string): { config: FunnelConfig; bearer: string } {
  const generated = generateTokens();
  generated.config.clients.personal = { ...generated.config.clients.personal!, upstream_token_file: path };
  return { config: generated.config, bearer: generated.plaintext.personal };
}

function writeGrant(dir: string, expiresAt: number, accessToken = STALE_TOKEN): string {
  const path = join(dir, 'personal.json');
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    client_id: 'client-test',
    client_secret: CLIENT_SECRET,
    access_token: accessToken,
    expires_at: expiresAt,
    profile: 'memory-writer',
  }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function serveUpstream(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

function tokenResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('upstream grant refresh', () => {
  test('refreshes before expires_at, inside the safety margin, and leaves a later token alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-before-'));
    const path = writeGrant(dir, NOW_SEC + UPSTREAM_REFRESH_MARGIN_SECONDS);
    const { config, bearer } = gateConfig(path);
    const hits: string[] = [];
    let tokenCalls = 0;
    const upstream = await serveUpstream((req, res) => {
      hits.push(String(req.headers.authorization ?? ''));
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const logs: string[] = [];
    const gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      now: () => NOW_MS,
      log: line => logs.push(line),
      repoRoot: repoRootFrom(import.meta.dir),
      fetchImpl: async (input, init) => {
        tokenCalls += 1;
        expect(String(input)).toBe(`http://127.0.0.1:${upstream.port}/token`);
        const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '');
        expect(body).toContain('grant_type=client_credentials');
        expect(body).toContain('client_id=client-test');
        expect(body).toContain(encodeURIComponent(CLIENT_SECRET));
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
      },
    });
    const port = await listenGate(gate);
    const response = await call(port, bearer);
    expect(response.status).toBe(200);
    expect(tokenCalls).toBe(1);
    expect(hits).toEqual([`Bearer ${MINTED_TOKEN}`]);
    const rewritten = JSON.parse(readFileSync(path, 'utf8')) as { access_token: string; expires_at: number; profile: string; client_secret: string };
    expect(rewritten.access_token).toBe(MINTED_TOKEN);
    expect(rewritten.expires_at).toBe(NOW_SEC + 3600);
    expect(rewritten.profile).toBe('memory-writer');
    expect(rewritten.client_secret).toBe(CLIENT_SECRET);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).some(name => name.includes('.tmp'))).toBe(false);
    const logged = logs.join('\n');
    expect(logged.includes(MINTED_TOKEN)).toBe(false);
    expect(logged.includes(STALE_TOKEN)).toBe(false);
    expect(logged.includes(CLIENT_SECRET)).toBe(false);
    expect(logged.includes(bearer)).toBe(false);

    const later = await call(port, bearer);
    expect(later.status).toBe(200);
    expect(tokenCalls).toBe(1);
    expect(hits[1]).toBe(`Bearer ${MINTED_TOKEN}`);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await upstream.close();
  });

  test('retries one upstream 401 with a new token and does not refresh again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-401-'));
    const path = writeGrant(dir, NOW_SEC + 3600);
    const { config, bearer } = gateConfig(path);
    let upstreamHits = 0;
    let tokenCalls = 0;
    const seen: string[] = [];
    const upstream = await serveUpstream((req, res) => {
      upstreamHits += 1;
      seen.push(String(req.headers.authorization ?? ''));
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token"}');
    });
    const gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      now: () => NOW_MS,
      log: () => {},
      fetchImpl: async () => {
        tokenCalls += 1;
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
      },
    });
    const port = await listenGate(gate);
    const response = await call(port, bearer);
    expect(response.status).toBe(401);
    expect(response.text).toContain('invalid_token');
    expect(upstreamHits).toBe(2);
    expect(tokenCalls).toBe(1);
    expect(seen).toEqual([`Bearer ${STALE_TOKEN}`, `Bearer ${MINTED_TOKEN}`]);
    expect(response.text.includes(CLIENT_SECRET)).toBe(false);
    expect(response.text.includes(MINTED_TOKEN)).toBe(false);
    expect(response.text.includes(STALE_TOKEN)).toBe(false);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await upstream.close();
  });

  test('rewrites the grant file atomically and mode 0600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-atomic-'));
    const path = join(dir, 'grant.json');
    const pad = 'p'.repeat(24_000);
    writePrivateJsonAtomic(path, { access_token: 'old-access-token', pad });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    let bad = 0;
    const readLoop = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          const text = readFileSync(path, 'utf8');
          const parsed = JSON.parse(text) as { access_token?: unknown };
          if (typeof parsed.access_token !== 'string' || !text.endsWith('\n')) bad += 1;
        } catch {
          bad += 1;
        }
      }
    };
    await Promise.all([
      readLoop(),
      readLoop(),
      (async () => {
        for (let i = 0; i < 30; i++) writePrivateJsonAtomic(path, { access_token: `tok-${i}`, pad });
      })(),
    ]);
    expect(bad).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([]);
    const finalText = readFileSync(path, 'utf8');
    expect(JSON.parse(finalText).pad).toBe(pad);
  });

  test('concurrent requests share one in-flight refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-single-'));
    const path = writeGrant(dir, NOW_SEC - 5);
    const { config, bearer } = gateConfig(path);
    let tokenCalls = 0;
    let release: () => void = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const hits: string[] = [];
    const upstream = await serveUpstream((req, res) => {
      hits.push(String(req.headers.authorization ?? ''));
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      now: () => NOW_MS,
      fetchImpl: async () => {
        tokenCalls += 1;
        await hold;
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
      },
    });
    let sockets = 0;
    gate.on('connection', socket => {
      sockets += 1;
      socket.on('error', () => {});
    });
    const port = await listenGate(gate);
    const pending = Promise.all([call(port, bearer), call(port, bearer)]);
    const deadline = Date.now() + 2_000;
    while ((sockets < 2 || tokenCalls < 1) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(sockets).toBeGreaterThanOrEqual(2);
    expect(tokenCalls).toBe(1);
    release();
    const results = await pending;
    expect(results.map(item => item.status)).toEqual([200, 200]);
    expect(hits).toEqual([`Bearer ${MINTED_TOKEN}`, `Bearer ${MINTED_TOKEN}`]);
    expect(tokenCalls).toBe(1);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await upstream.close();
  });

  test('an empty grant file is bad_gateway and is not proxied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-empty-'));
    const path = join(dir, 'personal.json');
    writeFileSync(path, '{}\n', { mode: 0o600 });
    const { config, bearer } = gateConfig(path);
    let tokenCalls = 0;
    const upstream = await serveUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should-not-proxy');
    });
    const gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      now: () => NOW_MS,
      fetchImpl: async () => {
        tokenCalls += 1;
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600 });
      },
    });
    const port = await listenGate(gate);
    const response = await call(port, bearer);
    expect(response.status).toBe(502);
    expect(response.text).toContain('bad_gateway');
    expect(response.text.includes('should-not-proxy')).toBe(false);
    expect(tokenCalls).toBe(0);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await upstream.close();
  });

  test('a failed refresh is 502 or 401 and includes no secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-fail-'));
    mkdirSync(join(dir, 'second'));
    const logs: string[] = [];
    const upstream = await serveUpstream((_req, res) => {
      res.writeHead(200);
      res.end('should-not-proxy');
    });
    const run = async (status: number, path: string) => {
      const { config, bearer } = gateConfig(path);
      const gate = createFunnelGate({
        config,
        upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
        now: () => NOW_MS,
        log: line => logs.push(line),
        fetchImpl: async () => tokenResponse(status, { error: 'invalid_client', client_secret: CLIENT_SECRET, access_token: STALE_TOKEN }),
      });
      const port = await listenGate(gate);
      const response = await call(port, bearer);
      expect(response.text.includes(bearer)).toBe(false);
      await new Promise<void>(resolve => gate.close(() => resolve()));
      return response;
    };
    const denied = await run(401, writeGrant(dir, NOW_SEC - 1));
    expect(denied.status).toBe(401);
    expect(denied.text).toContain('upstream_unauthorized');
    expect(denied.text.includes(CLIENT_SECRET)).toBe(false);
    expect(denied.text.includes(STALE_TOKEN)).toBe(false);
    expect(denied.text.includes('should-not-proxy')).toBe(false);

    const broken = await run(500, writeGrant(join(dir, 'second'), NOW_SEC - 1));
    expect(broken.status).toBe(502);
    expect(broken.text).toContain('upstream_token_refresh_failed');
    expect(broken.text.includes(CLIENT_SECRET)).toBe(false);
    expect(broken.text.includes(STALE_TOKEN)).toBe(false);
    const joined = logs.join('\n');
    expect(joined.includes(CLIENT_SECRET)).toBe(false);
    expect(joined.includes(STALE_TOKEN)).toBe(false);
    expect(joined.includes(MINTED_TOKEN)).toBe(false);
    await upstream.close();
  });

  test('a token-only grant file forwards serve 401 and does not call /token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-token-only-'));
    const path = join(dir, 'personal.json');
    writeFileSync(path, `${JSON.stringify({ access_token: STALE_TOKEN })}\n`, { mode: 0o600 });
    const { config, bearer } = gateConfig(path);
    let tokenCalls = 0;
    let upstreamHits = 0;
    const upstream = await serveUpstream((_req, res) => {
      upstreamHits += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token","source":"serve"}');
    });
    const gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
      now: () => NOW_MS,
      fetchImpl: async () => {
        tokenCalls += 1;
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
      },
    });
    const port = await listenGate(gate);
    const response = await call(port, bearer);
    expect(response.status).toBe(401);
    expect(response.text).toContain('invalid_token');
    expect(response.text).toContain('serve');
    expect(response.text.includes('upstream_unauthorized')).toBe(false);
    expect(tokenCalls).toBe(0);
    expect(upstreamHits).toBe(1);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ access_token: STALE_TOKEN });
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await upstream.close();
  });

  test('an in-flight refresh does not clobber a grant file replaced while /token is running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-replace-'));
    const sameCreds = join(dir, 'same.json');
    const changedCreds = join(dir, 'changed.json');
    writeFileSync(sameCreds, `${JSON.stringify({
      client_id: 'client-test',
      client_secret: CLIENT_SECRET,
      access_token: STALE_TOKEN,
      expires_at: NOW_SEC - 5,
      profile: 'memory-writer',
      generation: 1,
    })}\n`, { mode: 0o600 });
    writeFileSync(changedCreds, readFileSync(sameCreds));
    const replacement = {
      client_id: 'client-test',
      client_secret: CLIENT_SECRET,
      access_token: 'replaced-access-token',
      expires_at: NOW_SEC + 7200,
      profile: 'memory-reader',
      generation: 2,
    };
    const swapped = {
      client_id: 'client-replaced',
      client_secret: 'secret-replaced-do-not-log',
      access_token: 'swapped-access-token',
      expires_at: NOW_SEC + 7200,
      profile: 'memory-reader',
      generation: 9,
    };
    const run = async (path: string, during: () => void) => {
      const { config, bearer } = gateConfig(path);
      const hits: string[] = [];
      const local = await serveUpstream((req, res) => {
        hits.push(String(req.headers.authorization ?? ''));
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
      const gate = createFunnelGate({
        config,
        upstreamBaseUrl: `http://127.0.0.1:${local.port}`,
        now: () => NOW_MS,
        fetchImpl: async () => {
          during();
          return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
        },
      });
      const port = await listenGate(gate);
      const response = await call(port, bearer);
      await new Promise<void>(resolve => gate.close(() => resolve()));
      await local.close();
      return { response, hits, file: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> };
    };
    const merged = await run(sameCreds, () => writePrivateJsonAtomic(sameCreds, replacement));
    expect(merged.response.status).toBe(200);
    expect(merged.hits).toEqual([`Bearer ${MINTED_TOKEN}`]);
    expect(merged.file.profile).toBe('memory-reader');
    expect(merged.file.generation).toBe(2);
    expect(merged.file.access_token).toBe(MINTED_TOKEN);
    expect(merged.file.expires_at).toBe(NOW_SEC + 3600);
    expect(merged.file.client_id).toBe('client-test');
    expect(merged.file.client_secret).toBe(CLIENT_SECRET);

    const kept = await run(changedCreds, () => writePrivateJsonAtomic(changedCreds, swapped));
    expect(kept.response.status).toBe(200);
    expect(kept.hits).toEqual(['Bearer swapped-access-token']);
    expect(kept.file).toEqual(swapped);
    expect(kept.file.access_token).not.toBe(MINTED_TOKEN);
    expect(statSync(sameCreds).mode & 0o777).toBe(0o600);
    expect(statSync(changedCreds).mode & 0o777).toBe(0o600);

    const tokenless = join(dir, 'tokenless.json');
    writeFileSync(tokenless, `${JSON.stringify({
      client_id: 'client-test',
      client_secret: CLIENT_SECRET,
      access_token: STALE_TOKEN,
      expires_at: NOW_SEC - 5,
    })}\n`, { mode: 0o600 });
    const bare = { client_id: 'client-replaced', client_secret: 'secret-replaced-do-not-log', profile: 'memory-reader' };
    const deniedHits: string[] = [];
    let tokenCalls = 0;
    const deniedUpstream = await serveUpstream((req, res) => {
      deniedHits.push(String(req.headers.authorization ?? ''));
      req.resume();
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_token","source":"serve"}');
    });
    const deniedConfig = gateConfig(tokenless);
    const deniedGate = createFunnelGate({
      config: deniedConfig.config,
      upstreamBaseUrl: `http://127.0.0.1:${deniedUpstream.port}`,
      now: () => NOW_MS,
      fetchImpl: async () => {
        tokenCalls += 1;
        writePrivateJsonAtomic(tokenless, bare);
        return tokenResponse(200, { access_token: MINTED_TOKEN, expires_in: 3600, token_type: 'bearer' });
      },
    });
    const deniedPort = await listenGate(deniedGate);
    const denied = await call(deniedPort, deniedConfig.bearer);
    expect(denied.status).toBe(401);
    expect(denied.text).toContain('invalid_token');
    expect(denied.text).toContain('serve');
    expect(denied.text.includes('upstream_unauthorized')).toBe(false);
    expect(tokenCalls).toBe(1);
    expect(deniedHits).toEqual(['']);
    expect(JSON.parse(readFileSync(tokenless, 'utf8'))).toEqual(bare);
    await new Promise<void>(resolve => deniedGate.close(() => resolve()));
    await deniedUpstream.close();
  });
});
