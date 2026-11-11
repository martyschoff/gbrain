/**
 * Offline tests for the shared-brain Funnel gate, token file, and index.lock clearer.
 * Listeners and the mock upstream bind 127.0.0.1 only.
 */
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BODY_LIMIT, BODY_READ_TIMEOUT_MS, createFunnelGate, listenGate } from '../scripts/grok-shared-brain/gate.ts';
import { clearStaleIndexLock, gitIsRunning, isGitComm, listLocalProcesses, parsePs, REFUSED_WITHOUT_FORCE, STALE_INDEX_LOCK_MS } from '../scripts/grok-shared-brain/index-lock.ts';
import { evaluateMcpBody } from '../scripts/grok-shared-brain/mcp-policy.ts';
import { findFunnelEnableInvocations, FUNNEL_ENABLE_COMMAND, readScriptTree, requestFunnelEnable } from '../scripts/grok-shared-brain/funnel-policy.ts';
import { evaluateHostGuard, guardThisHost, parseExpectedHost, shortHostname } from '../scripts/grok-shared-brain/host-guard.ts';
import { authenticate, configContainsPlaintext, fsyncDirectory, generateTokens, parseFunnelConfig, pathInside, repoRootFrom, sha256Hex, tokenMatchesHash, withUpstreamTokenFiles, writeTokenFile, type FunnelConfig } from '../scripts/grok-shared-brain/tokens.ts';

const DESIGN_SHA = 'f84e310bb49af8f4449406053cbcff357f74253a993304e577966ac8667444b4';
const SCRIPT_DIR = join(import.meta.dir, '../scripts/grok-shared-brain');
const ROUTES: { method: string; path: string; body?: string }[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/mcp' },
  { method: 'POST', path: '/mcp', body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' },
  { method: 'DELETE', path: '/mcp' },
  { method: 'GET', path: '/admin' },
  { method: 'GET', path: '/admin/api/stats' },
  { method: 'POST', path: '/admin/login', body: '{}' },
  { method: 'GET', path: '/metrics' },
  { method: 'GET', path: '/.well-known/gbrain' },
  { method: 'POST', path: '/token', body: 'grant_type=x' },
  { method: 'GET', path: '/register' },
  { method: 'POST', path: '/revoke', body: '{}' },
  { method: 'GET', path: '/authorize' },
  { method: 'GET', path: '/no-such-route' },
];

interface Hit { method: string; url: string; authorization: string }

function remember(source: string, tool = 'remember'): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { text: 'fixture', source } } });
}

async function call(port: number, method: string, path: string, token?: string, body?: string): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  return { status: response.status, text: await response.text() };
}

describe('design pin', () => {
  test('round-3 design sha is unchanged', () => {
    const bytes = readFileSync(join(import.meta.dir, '../docs/grok/gbrain-shared-brain-design-r3.md'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(DESIGN_SHA);
  });
});

describe('funnel tokens', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gbrain-funnel-tokens-'));

  test('generated file is hashes only, funnel off, mode 0600, outside the repo', () => {
    const generated = generateTokens();
    expect(generated.config.funnel_enabled).toBe(false);
    expect(Object.keys(generated.plaintext).sort()).toEqual(['business', 'hermes', 'personal']);
    const destination = join(scratch, 'funnel-tokens.json');
    const repo = repoRootFrom(import.meta.dir);
    writeTokenFile(destination, generated.config, repo);
    const text = readFileSync(destination, 'utf8');
    expect(configContainsPlaintext(text, generated.plaintext)).toBe(false);
    expect(text.includes('gbft_')).toBe(false);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    expect(() => writeTokenFile(join(repo, 'funnel-tokens.json'), generated.config, repo)).toThrow(/inside the repo/);
    const parsed = parseFunnelConfig(JSON.parse(text));
    expect(parsed.clients.personal?.write).toEqual(['personal']);
    expect(parsed.clients.personal?.read).toEqual(['personal', 'shared']);
    expect(tokenMatchesHash(generated.plaintext.personal, parsed.clients.personal!.token_sha256)).toBe(true);
    expect(tokenMatchesHash('gbft_not-the-token', parsed.clients.personal!.token_sha256)).toBe(false);
    expect(tokenMatchesHash(generated.plaintext.personal, 'zz')).toBe(false);
  });

  test('parser rejects a shared write grant', () => {
    const generated = generateTokens();
    generated.config.clients.personal!.write = ['personal', 'shared'];
    expect(() => parseFunnelConfig(generated.config)).toThrow(/must not write shared/);
  });

  test('parser rejects a duplicate token hash and does not show the hash', () => {
    const generated = generateTokens();
    const hash = generated.config.clients.personal!.token_sha256;
    generated.config.clients.business!.token_sha256 = hash.toUpperCase();
    expect(() => parseFunnelConfig(generated.config)).toThrow(/duplicate token_sha256 for clients personal, business/);
    try {
      parseFunnelConfig(generated.config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.includes(hash.toLowerCase())).toBe(false);
      expect(message.includes(hash.toUpperCase())).toBe(false);
    }
  });

  test('writeTokenFile replaces via a 0600 temp file in the same directory', () => {
    const generated = generateTokens();
    const destination = join(scratch, 'atomic.json');
    const repo = repoRootFrom(import.meta.dir);
    writeTokenFile(destination, generated.config, repo);
    const first = statSync(destination);
    expect(first.mode & 0o777).toBe(0o600);
    generated.config.rate_limit.max = 7;
    writeTokenFile(destination, generated.config, repo);
    const second = statSync(destination);
    expect(second.ino).not.toBe(first.ino);
    expect(second.mode & 0o777).toBe(0o600);
    expect(readFileSync(destination, 'utf8')).toContain('"max": 7');
    expect(readdirSync(scratch).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  test('directory fsync ignores EINVAL and EISDIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-fsync-dir-'));
    const refuse = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(() => fsyncDirectory(dir, refuse('EINVAL'))).not.toThrow();
    expect(() => fsyncDirectory(dir, refuse('EISDIR'))).not.toThrow();
    expect(() => fsyncDirectory(dir, refuse('EIO'))).toThrow();
    expect(() => fsyncDirectory(dir)).not.toThrow();
  });

  test('compare uses timingSafeEqual', () => {
    const source = readFileSync(join(SCRIPT_DIR, 'tokens.ts'), 'utf8');
    expect(source.includes('timingSafeEqual')).toBe(true);
    expect(source.includes('presented ===')).toBe(false);
    expect(source.includes('presented ==')).toBe(false);
  });

  test('generate command writes hashes and does not enable funnel', () => {
    const destination = join(scratch, 'cli-tokens.json');
    const ran = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-generate-tokens.ts'), '--out', destination], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    const printed = JSON.parse(ran.stdout) as Record<string, string>;
    const file = readFileSync(destination, 'utf8');
    expect(configContainsPlaintext(file, printed)).toBe(false);
    expect(file.includes('"funnel_enabled": false')).toBe(true);
    expect(ran.stderr.includes('ran=false')).toBe(true);
    const again = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-generate-tokens.ts'), '--out', destination], { encoding: 'utf8' });
    expect(again.status).toBe(1);
  });
});

describe('funnel stays off', () => {
  test('requestFunnelEnable does not run tailscale', () => {
    const result = requestFunnelEnable();
    expect(result).toEqual({ enabled: false, ran: false, command: FUNNEL_ENABLE_COMMAND });
    expect(FUNNEL_ENABLE_COMMAND).toBe('tailscale funnel --bg 8767');
    const source = readFileSync(join(SCRIPT_DIR, 'funnel-policy.ts'), 'utf8');
    expect(source.includes('child_process')).toBe(false);
    expect(source.includes('spawn(')).toBe(false);
  });

  test('checked-in scripts do not invoke tailscale funnel', () => {
    expect(findFunnelEnableInvocations(readScriptTree(SCRIPT_DIR))).toEqual([]);
    const sample = findFunnelEnableInvocations([{ name: 'bad.sh', text: 'tailscale funnel --bg 8767\n' }]);
    expect(sample).toEqual(['bad.sh:1']);
    const echoed = findFunnelEnableInvocations([{ name: 'ok.sh', text: 'echo "tailscale funnel --bg 8767"\n' }]);
    expect(echoed).toEqual([]);
  });

  test('docs name the operator command and setup.sh only prints it', () => {
    for (const path of ['../docs/grok/BUILD-NOTES.md', '../docs/grok/shared-brain/README.md']) {
      expect(readFileSync(join(import.meta.dir, path), 'utf8')).toContain('tailscale funnel --bg 8767');
    }
    const home = mkdtempSync(join(tmpdir(), 'gbrain-setup-home-'));
    const host = spawnSync('hostname', ['-s'], { encoding: 'utf8' }).stdout.trim();
    mkdirSync(join(home, '.gbrain', 'serve'), { recursive: true });
    const hostEnv = join(home, '.gbrain', 'serve', 'host.env');
    writeFileSync(hostEnv, `GBRAIN_EXPECTED_HOST=${host}\n`);
    const ran = spawnSync('bash', ['-x', join(SCRIPT_DIR, 'setup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: process.env.PATH },
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('Funnel is OFF');
    expect(ran.stdout).toContain('tailscale funnel --bg 8767');
    const trace = `${ran.stderr}\n${ran.stdout}`;
    expect(trace.split('\n').some(line => /^\+ tailscale\b/.test(line))).toBe(false);
    const missing = spawnSync('bash', [join(SCRIPT_DIR, 'setup.sh')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), 'gbrain-setup-missing-')) },
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('host.env');
    expect(missing.stderr).toContain('GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>');
    writeFileSync(hostEnv, '# no assignment\n');
    const unset = spawnSync('bash', [join(SCRIPT_DIR, 'setup.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(unset.status).not.toBe(0);
    expect(unset.stderr).toContain('GBRAIN_EXPECTED_HOST is missing');
    writeFileSync(hostEnv, 'GBRAIN_EXPECTED_HOST=not-this-machine\n');
    const wrong = spawnSync('bash', [join(SCRIPT_DIR, 'setup.sh')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('does not match GBRAIN_EXPECTED_HOST');
  });

  test('print command exits without enabling funnel', () => {
    const ran = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-print-funnel.ts')], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe(FUNNEL_ENABLE_COMMAND);
  });
});

describe('funnel gate', () => {
  const logs: string[] = [];
  const hits: Hit[] = [];
  let upstream: ReturnType<typeof createServer>;
  let gate: ReturnType<typeof createServer>;
  let port = 0;
  let tokens: Record<string, string> = {};
  let config: FunnelConfig;

  beforeAll(async () => {
    const generated = generateTokens();
    tokens = { ...generated.plaintext, limited: 'gbft_limited_empty_routes' };
    config = generated.config;
    config.clients.limited = { token_sha256: sha256Hex(tokens.limited!), routes: [], write: [], read: [] };
    upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : '',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ upstream: true, bytes: Buffer.concat(chunks).length }));
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    gate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      log: line => logs.push(line),
      rateLimit: { windowMs: 60_000, max: 10_000 },
    });
    port = await listenGate(gate);
  });

  afterAll(async () => {
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  test('binds loopback and refuses a non-loopback upstream', () => {
    const address = gate.address();
    expect(typeof address === 'object' && address && address.address).toBe('127.0.0.1');
    expect(() => createFunnelGate({ config, upstreamBaseUrl: 'http://example.invalid:8766' })).toThrow(/loopback/);
    expect(() => createFunnelGate({ config, upstreamBaseUrl: 'https://127.0.0.1:8766' })).toThrow(/loopback/);
  });

  test('no token, bad token, and empty-scope token are refused on every route', async () => {
    for (const route of ROUTES) {
      const missing = await call(port, route.method, route.path, undefined, route.body);
      const bad = await call(port, route.method, route.path, 'gbft_not-a-client', route.body);
      const wrong = await call(port, route.method, route.path, tokens.limited, route.body);
      expect(missing.status).toBe(401);
      expect(bad.status).toBe(401);
      expect(wrong.status).toBe(403);
      expect(missing.text.includes('gbft_')).toBe(false);
      expect(bad.text.includes(tokens.personal!)).toBe(false);
    }
  });

  test('admin routes and shared writes are refused with a valid token', async () => {
    const before = hits.length;
    for (const path of ['/admin', '/admin/api/stats', '/admin/login', '/metrics', '/token', '/register', '/revoke', '/authorize', '/.well-known/gbrain']) {
      const response = await call(port, 'GET', path, tokens.personal);
      expect(response.status).toBe(403);
      expect(response.text).toContain('admin_forbidden');
    }
    const shared = await call(port, 'POST', '/mcp', tokens.personal, remember('shared'));
    expect(shared.status).toBe(403);
    expect(shared.text).toContain('shared_write_forbidden');
    const other = await call(port, 'POST', '/mcp', tokens.personal, remember('business'));
    expect(other.status).toBe(403);
    expect(other.text).toContain('wrong_scope');
    const missingSource = await call(port, 'POST', '/mcp', tokens.personal, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: { text: 'fixture' } },
    }));
    expect(missingSource.status).toBe(403);
    expect(missingSource.text).toContain('wrong_scope');
    const emptySource = await call(port, 'POST', '/mcp', tokens.personal, remember(''));
    expect(emptySource.status).toBe(403);
    expect(emptySource.text).toContain('wrong_scope');
    const header = await call(port, 'POST', '/mcp?source=shared', tokens.hermes, '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    expect(header.status).toBe(403);
    expect(hits.length).toBe(before);
  });

  test('a write with a missing, empty, or wrong source is refused', () => {
    const record = config.clients.personal!;
    const callTool = (args: Record<string, unknown>) => evaluateMcpBody(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'remember', arguments: args },
    }), record);
    expect(callTool({ text: 'fixture' })).toEqual({ ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' });
    expect(callTool({ text: 'fixture', source: '' })).toEqual({ ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' });
    expect(callTool({ text: 'fixture', source: 'business' })).toEqual({ ok: false, status: 403, error: 'forbidden', code: 'wrong_scope' });
    expect(callTool({ text: 'fixture', source: 'personal' })).toEqual({ ok: true });
  });

  test('a token that lists shared as writable is still refused', () => {
    const record = { ...config.clients.personal!, write: ['personal', 'shared'] };
    const decision = evaluateMcpBody(remember('shared', 'put_page'), record);
    expect(decision).toEqual({ ok: false, status: 403, error: 'forbidden', code: 'shared_write_forbidden' });
  });

  test('in-scope health, mcp, and shared reads proxy without the funnel bearer', async () => {
    const before = hits.length;
    const health = await call(port, 'GET', '/health', tokens.business);
    expect(health.status).toBe(200);
    const own = await call(port, 'POST', '/mcp', tokens.personal, remember('personal'));
    expect(own.status).toBe(200);
    const read = await call(port, 'POST', '/mcp', tokens.hermes, remember('shared', 'recall'));
    expect(read.status).toBe(200);
    const forwarded = hits.slice(before);
    expect(forwarded.length).toBe(3);
    for (const hit of forwarded) {
      expect(hit.authorization).toBe('');
      for (const token of Object.values(tokens)) expect(hit.authorization.includes(token)).toBe(false);
    }
  });

  test('a chunked oversize body is 413 and the socket stays open', async () => {
    const payload = Buffer.alloc(BODY_LIMIT + 32, 0x61);
    const result = await new Promise<{ status: number; body: string; error: string }>((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.personal}`,
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          error: '',
        }));
      });
      req.on('error', error => reject(error));
      req.end(payload);
    });
    expect(result.error).toBe('');
    expect(result.status).toBe(413);
    expect(result.body).toContain('too_large');
  });

  test('a declared oversize Content-Length with no body is 413 promptly', async () => {
    const started = Date.now();
    const result = await new Promise<{ status: number; body: string; connection: string }>((resolve, reject) => {
      let status = 0;
      let connection = '';
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.personal}`,
          'content-type': 'application/json',
          'content-length': String(BODY_LIMIT + 1),
        },
      }, response => {
        status = response.statusCode ?? 0;
        connection = String(response.headers.connection ?? '');
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), connection }));
      });
      req.on('error', error => {
        if (status !== 0) resolve({ status, body: '', connection });
        else reject(error);
      });
      req.flushHeaders();
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.status).toBe(413);
    expect(result.body).toContain('too_large');
    expect(result.connection).toBe('close');
  });

  test('a stalled body is 408 when the read times out', async () => {
    const started = Date.now();
    const result = await new Promise<{ status: number; body: string; connection: string }>((resolve, reject) => {
      let status = 0;
      let connection = '';
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.personal}`,
          'content-type': 'application/json',
          'content-length': '64',
        },
      }, response => {
        status = response.statusCode ?? 0;
        connection = String(response.headers.connection ?? '');
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8'), connection }));
      });
      req.on('error', error => {
        if (status !== 0) resolve({ status, body: '', connection });
        else reject(error);
      });
      req.flushHeaders();
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(BODY_READ_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(BODY_READ_TIMEOUT_MS + 3_000);
    expect(result.status).toBe(408);
    expect(result.body).toContain('request_timeout');
    expect(result.connection).toBe('close');
  }, BODY_READ_TIMEOUT_MS + 5_000);

  test('a small body still proxies', async () => {
    const response = await call(port, 'POST', '/mcp', tokens.personal, remember('personal'));
    expect(response.status).toBe(200);
    expect(response.text).toContain('upstream');
  });

  test('query-string bearers are not accepted and tokens never appear in logs', async () => {
    logs.length = 0;
    const sneaky = tokens.personal!;
    const response = await call(port, 'GET', `/health?access_token=${sneaky}`);
    expect(response.status).toBe(401);
    await call(port, 'GET', '/health', sneaky);
    const joined = logs.join('\n');
    for (const token of Object.values(tokens)) expect(joined.includes(token)).toBe(false);
    expect(joined.includes('authorization')).toBe(false);
    expect(authenticate(`Bearer ${sneaky}`, config).ok).toBe(true);
    expect(authenticate(undefined, config).ok).toBe(false);
  });

  test('forwarding and hop-by-hop headers from the client do not reach upstream', async () => {
    const seen: Record<string, string | string[] | undefined>[] = [];
    const localUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      seen.push(req.headers);
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(resolve => localUpstream.listen(0, '127.0.0.1', resolve));
    const localGate = createFunnelGate({
      config,
      upstreamBaseUrl: `http://127.0.0.1:${(localUpstream.address() as { port: number }).port}`,
    });
    const localPort = await listenGate(localGate);
    const spoofed = [
      ['Connection', 'x-via-connection'],
      ['TE', 'spoof-te'],
      ['Upgrade', 'spoof-upgrade'],
      ['Keep-Alive', 'spoof-keep-alive'],
      ['Proxy-Connection', 'spoof-proxy-connection'],
      ['Proxy-Authorization', 'spoof-proxy-authorization'],
      ['Trailer', 'spoof-trailer'],
      ['X-Forwarded-For', '203.0.113.50'],
      ['X-Forwarded-Proto', 'https'],
      ['X-Forwarded-Host', 'spoof.example'],
      ['X-Forwarded-Port', '444'],
      ['X-Real-Ip', '203.0.113.51'],
      ['Forwarded', 'for=203.0.113.52;proto=https;host=spoof.example'],
      ['X-Via-Connection', 'spoof-connection-named'],
      ['X-Gbrain-Keep', 'kept-marker'],
    ];
    const raw = (headerLines: string[]) => new Promise<string>((resolve, reject) => {
      const sock = connectTcp(localPort, '127.0.0.1', () => {
        sock.write([
          'GET /health HTTP/1.1',
          `Host: 127.0.0.1:${localPort}`,
          `Authorization: Bearer ${tokens.personal}`,
          ...headerLines,
          '',
          '',
        ].join('\r\n'));
      });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('spoof request timed out'));
      }, 3_000);
      sock.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text.includes('\r\n\r\n')) {
          clearTimeout(timer);
          sock.end();
          resolve(text);
        }
      });
      sock.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    try {
      const response = await raw(spoofed.map(([name, value]) => `${name}: ${value}`));
      expect(response.startsWith('HTTP/1.1 200')).toBe(true);
      expect(seen.length).toBe(1);
      const forwarded = JSON.stringify(seen[0]).toLowerCase();
      for (const [, value] of spoofed) {
        expect(forwarded.includes(value.toLowerCase())).toBe(false);
      }
      expect(seen[0]?.['x-forwarded-for']).toBeUndefined();
      expect(seen[0]?.['x-forwarded-proto']).toBeUndefined();
      const transfer = await raw(['Transfer-Encoding: spoof-transfer']);
      expect(transfer.startsWith('HTTP/1.1')).toBe(true);
      expect(JSON.stringify(seen).toLowerCase().includes('spoof-transfer')).toBe(false);
      const dropped = [
        ['True-Client-IP', '203.0.113.60'],
        ['CF-Connecting-IP', '203.0.113.61'],
        ['X-Client-IP', '203.0.113.62'],
        ['X-Original-Forwarded-For', '203.0.113.63'],
        ['X-Forwarded-Scheme', 'https'],
        ['X-Forwarded-Prefix', '/spoof-prefix'],
        ['Forwarded-For', '203.0.113.64'],
        ['Via', 'spoof-via'],
      ];
      const allowed = [
        ['Content-Type', 'application/json'],
        ['Accept', 'application/json, text/event-stream'],
        ['Accept-Encoding', 'gzip'],
        ['User-Agent', 'mcp-client-test'],
        ['Mcp-Session-Id', 'session-keep'],
        ['Mcp-Protocol-Version', '2025-06-18'],
        ['Last-Event-ID', 'event-keep'],
      ];
      const passed = await raw([
        ...dropped.map(([name, value]) => `${name}: ${value}`),
        ...allowed.map(([name, value]) => `${name}: ${value}`),
      ]);
      expect(passed.startsWith('HTTP/1.1 200')).toBe(true);
      const hit = seen[seen.length - 1] ?? {};
      const forwardedAgain = JSON.stringify(hit).toLowerCase();
      for (const [, value] of dropped) expect(forwardedAgain.includes(value.toLowerCase())).toBe(false);
      for (const [name, value] of allowed) expect(hit[name.toLowerCase()]).toBe(value);
      expect(hit['x-forwarded-proto']).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => localGate.close(() => resolve()));
      await new Promise<void>(resolve => localUpstream.close(() => resolve()));
    }
  });

  test('forwards a grant access_token from outside the repo and does not log it', async () => {
    const grant = 'gbrain-grant-test-token';
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-grant-'));
    const file = join(dir, 'personal.json');
    writeFileSync(file, JSON.stringify({ access_token: grant }));
    const localLogs: string[] = [];
    const localHits: Hit[] = [];
    const localUpstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      localHits.push({ method: req.method ?? '', url: req.url ?? '', authorization: String(req.headers.authorization ?? '') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(resolve => localUpstream.listen(0, '127.0.0.1', resolve));
    const withGrant: FunnelConfig = structuredClone(config);
    withGrant.clients.personal = { ...withGrant.clients.personal!, upstream_token_file: file };
    const server = createFunnelGate({
      config: withGrant,
      upstreamBaseUrl: `http://127.0.0.1:${(localUpstream.address() as { port: number }).port}`,
      log: line => localLogs.push(line),
      repoRoot: repoRootFrom(import.meta.dir),
    });
    const localPort = await listenGate(server);
    const response = await call(localPort, 'GET', '/health', tokens.personal);
    expect(response.status).toBe(200);
    expect(localHits[0]?.authorization).toBe(`Bearer ${grant}`);
    expect(localHits[0]?.authorization.includes(tokens.personal!)).toBe(false);
    expect(localLogs.join('\n').includes(grant)).toBe(false);
    expect(localLogs.join('\n').includes(tokens.personal!)).toBe(false);
    expect(() => createFunnelGate({
      config: withGrant,
      upstreamBaseUrl: 'http://127.0.0.1:9',
      repoRoot: dir,
    })).toThrow(/outside the repo/);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => localUpstream.close(() => resolve()));
  });
});

describe('rate limit', () => {
  test('the fourth request for one token is 429 and another token still passes', async () => {
    const generated = generateTokens();
    const hits: string[] = [];
    const upstream = createServer((_req, res) => { hits.push('hit'); res.writeHead(200); res.end('ok'); });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    let now = 1_700_000_000_000;
    const gate = createFunnelGate({
      config: generated.config,
      upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      now: () => now,
      rateLimit: { windowMs: 60_000, max: 3 },
    });
    const port = await listenGate(gate);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(port, 'GET', '/health', generated.plaintext.personal)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    const other = await call(port, 'GET', '/health', generated.plaintext.business);
    expect(other.status).toBe(200);
    expect(hits.length).toBe(4);
    now += 60_001;
    const again = await call(port, 'GET', '/health', generated.plaintext.personal);
    expect(again.status).toBe(200);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
});

describe('index.lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-index-lock-'));

  function checkout(name: string): string {
    const dir = join(root, name);
    mkdirSync(join(dir, '.git'), { recursive: true });
    return dir;
  }

  function lock(dir: string, ageMs: number): string {
    const path = join(dir, '.git', 'index.lock');
    writeFileSync(path, '');
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  test('git command names', () => {
    expect(isGitComm('git')).toBe(true);
    expect(isGitComm('git.exe')).toBe(true);
    expect(isGitComm('/usr/bin/git')).toBe(true);
    expect(isGitComm('git-remote-https')).toBe(true);
    expect(isGitComm('github')).toBe(false);
    expect(gitIsRunning(parsePs('  4 bash\n  9 git\n'))).toBe(true);
    expect(gitIsRunning(parsePs('  4 bash\n'))).toBe(false);
  });

  test('clears a stale lock only when no git process is running', () => {
    const dir = checkout('clear');
    const path = lock(dir, STALE_INDEX_LOCK_MS + 5_000);
    const none = clearStaleIndexLock(dir, { force: true, listProcesses: () => [] });
    expect(none).toEqual({ cleared: true, reason: 'cleared' });
    expect(existsSync(path)).toBe(false);

    const kept = checkout('kept');
    const keptLock = lock(kept, STALE_INDEX_LOCK_MS + 5_000);
    const running = clearStaleIndexLock(kept, { force: true, listProcesses: () => [{ pid: 40, comm: 'git' }] });
    expect(running).toEqual({ cleared: false, reason: 'git_running' });
    expect(existsSync(keptLock)).toBe(true);

    const fresh = checkout('fresh');
    const freshLock = lock(fresh, 1_000);
    expect(clearStaleIndexLock(fresh, { force: true, listProcesses: () => [] }).reason).toBe('lock_not_stale');
    expect(existsSync(freshLock)).toBe(true);

    const future = checkout('future');
    const futureLock = lock(future, -60_000);
    expect(clearStaleIndexLock(future, { force: true, listProcesses: () => [] }).reason).toBe('lock_dated_in_the_future');
    expect(existsSync(futureLock)).toBe(true);

    const blind = checkout('blind');
    lock(blind, STALE_INDEX_LOCK_MS + 5_000);
    expect(clearStaleIndexLock(blind, { force: true, listProcesses: () => null }).reason).toBe('process_table_unreadable');

    let calls = 0;
    const raced = checkout('raced');
    const racedLock = lock(raced, STALE_INDEX_LOCK_MS + 5_000);
    const race = clearStaleIndexLock(raced, {
      force: true,
      listProcesses: () => {
        calls += 1;
        return calls === 1 ? [] : [{ pid: 7, comm: 'git' }];
      },
    });
    expect(race.reason).toBe('git_running');
    expect(existsSync(racedLock)).toBe(true);
  });

  test('refuses a symlink lock and a symlinked git dir', () => {
    const dir = checkout('symlink');
    const real = join(root, 'real-lock');
    writeFileSync(real, '');
    symlinkSync(real, join(dir, '.git', 'index.lock'));
    expect(clearStaleIndexLock(dir, { force: true, listProcesses: () => [] }).reason).toBe('lock_not_a_regular_file');
    expect(existsSync(real)).toBe(true);

    const linked = join(root, 'linked');
    mkdirSync(linked, { recursive: true });
    symlinkSync(join(dir, '.git'), join(linked, '.git'));
    expect(clearStaleIndexLock(linked, { force: true, listProcesses: () => [] }).reason).toBe('git_dir_not_a_real_directory');
  });

  test('refuses to clear unless --force, then clears only when the checks pass', () => {
    const dir = checkout('force');
    const path = lock(dir, STALE_INDEX_LOCK_MS + 5_000);
    const refused = clearStaleIndexLock(dir, { listProcesses: () => [] });
    expect(refused).toEqual({ cleared: false, reason: 'refused_without_force' });
    expect(existsSync(path)).toBe(true);
    const cli = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-clear-index-lock.ts'), dir], { encoding: 'utf8' });
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain(REFUSED_WITHOUT_FORCE);
    expect(existsSync(path)).toBe(true);
    const local = listLocalProcesses();
    if (local && gitIsRunning(local)) {
      const blocked = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-clear-index-lock.ts'), dir, '--force'], { encoding: 'utf8' });
      expect(blocked.status).not.toBe(0);
      expect(existsSync(path)).toBe(true);
      const forced = clearStaleIndexLock(dir, { force: true, listProcesses: () => [] });
      expect(forced).toEqual({ cleared: true, reason: 'cleared' });
    } else {
      const forced = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-clear-index-lock.ts'), dir, '--force'], { encoding: 'utf8' });
      expect(forced.status).toBe(0);
      expect(forced.stdout).toContain('"cleared":true');
    }
    expect(existsSync(path)).toBe(false);
  });

  test('a live process whose command is git keeps the lock', () => {
    const dir = checkout('live');
    const path = lock(dir, STALE_INDEX_LOCK_MS + 5_000);
    const bin = mkdtempSync(join(tmpdir(), 'gbrain-fake-git-'));
    const fake = join(bin, 'git');
    copyFileSync('/bin/sleep', fake);
    chmodSync(fake, 0o755);
    const child = spawn(fake, ['30'], { stdio: 'ignore' });
    try {
      const pid = child.pid;
      expect(typeof pid).toBe('number');
      const deadline = Date.now() + 3_000;
      let visible = false;
      while (Date.now() < deadline) {
        const listed = listLocalProcesses();
        if (listed?.some(process => process.pid === pid && isGitComm(process.comm))) { visible = true; break; }
        spawnSync('sleep', ['0.05']);
      }
      expect(visible).toBe(true);
      const result = clearStaleIndexLock(dir, { force: true });
      expect(result.cleared).toBe(false);
      expect(result.reason).toBe('git_running');
      expect(existsSync(path)).toBe(true);
      const listed = listLocalProcesses();
      expect(listed).not.toBeNull();
      expect(gitIsRunning(listed ?? [])).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('step 4', () => {
  test('commits with a repo-local identity and refuses a placeholder root', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-step4-home-'));
    const root = mkdtempSync(join(tmpdir(), 'gbrain-step4-root-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      GIT_CONFIG_GLOBAL: join(home, 'no-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GBRAIN_MLSFS_ROOT: root,
    };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;
    const ran = spawnSync('bash', [join(SCRIPT_DIR, 'step4-sources.sh')], { encoding: 'utf8', env });
    expect(ran.status).toBe(0);
    for (const source of ['personal', 'business', 'hermes', 'shared']) {
      const log = spawnSync('git', ['-C', join(root, source), 'log', '-1', '--format=%an%n%ae'], { encoding: 'utf8', env });
      expect(log.stdout).toBe('gbrain\ngbrain@localhost\n');
      expect(readFileSync(join(root, source, 'README.md'), 'utf8')).toContain(`# ${source}`);
    }
    const again = spawnSync('bash', [join(SCRIPT_DIR, 'step4-sources.sh')], { encoding: 'utf8', env });
    expect(again.status).toBe(0);
    const placeholder = spawnSync('bash', [join(SCRIPT_DIR, 'step4-sources.sh')], {
      encoding: 'utf8',
      env: { ...env, GBRAIN_MLSFS_ROOT: '/Volumes/<share>/personalgrok/gbrain' },
    });
    expect(placeholder.status).toBe(1);
    expect(pathInside(join(root, 'personal'), root)).toBe(true);
  });
});

interface XmlNode { tag: string; text: string; children: XmlNode[] }

function parseXml(source: string): XmlNode {
  const xml = source.replace(/<\?xml[^?]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '').trim();
  let index = 0;
  const skip = () => {
    while (xml[index] === ' ' || xml[index] === '\n' || xml[index] === '\r' || xml[index] === '\t') index += 1;
  };
  const parseNode = (): XmlNode => {
    skip();
    if (xml[index] !== '<') throw new Error(`expected a tag at ${index}`);
    index += 1;
    let tag = '';
    while (xml[index] && xml[index] !== '>' && xml[index] !== '/' && xml[index] !== ' ' && xml[index] !== '\n') {
      tag += xml[index];
      index += 1;
    }
    while (xml[index] && xml[index] !== '>' && xml[index] !== '/') index += 1;
    if (xml[index] === '/') {
      if (xml[index + 1] !== '>') throw new Error(`unclosed empty tag ${tag}`);
      index += 2;
      return { tag, text: '', children: [] };
    }
    if (xml[index] !== '>') throw new Error(`unclosed tag ${tag}`);
    index += 1;
    const children: XmlNode[] = [];
    let text = '';
    while (index < xml.length) {
      if (xml[index] === '<') {
        if (xml[index + 1] === '/') {
          const end = xml.indexOf('>', index + 2);
          const close = xml.slice(index + 2, end);
          if (close !== tag) throw new Error(`mismatched ${tag} and ${close}`);
          index = end + 1;
          return { tag, text: text.trim(), children };
        }
        children.push(parseNode());
        continue;
      }
      text += xml[index];
      index += 1;
    }
    throw new Error(`unclosed ${tag}`);
  };
  const root = parseNode();
  skip();
  if (index !== xml.length) throw new Error('trailing markup');
  return root;
}

function plistDict(root: XmlNode): Map<string, XmlNode> {
  const dict = root.children.find(node => node.tag === 'dict');
  if (!dict) throw new Error('plist dict missing');
  const map = new Map<string, XmlNode>();
  for (let cursor = 0; cursor < dict.children.length; cursor += 2) {
    const key = dict.children[cursor];
    const value = dict.children[cursor + 1];
    if (!key || key.tag !== 'key' || !value) throw new Error('plist key/value pair is incomplete');
    map.set(key.text, value);
  }
  return map;
}

describe('launchd plist', () => {
  const template = readFileSync(join(SCRIPT_DIR, 'launchd', 'com.gbrain.funnel-gate.plist'), 'utf8');

  test('the template is well-formed and keeps absolute-path placeholders', () => {
    const dict = plistDict(parseXml(template));
    expect(dict.get('Label')?.text).toBe('com.gbrain.funnel-gate');
    expect(dict.get('RunAtLoad')?.tag).toBe('true');
    const keepAlive = dict.get('KeepAlive');
    expect(keepAlive?.tag).toBe('dict');
    const keepAliveKeys = new Map<string, XmlNode>();
    for (let cursor = 0; cursor < (keepAlive?.children.length ?? 0); cursor += 2) {
      const key = keepAlive?.children[cursor];
      const value = keepAlive?.children[cursor + 1];
      if (key?.tag === 'key' && value) keepAliveKeys.set(key.text, value);
    }
    expect(keepAliveKeys.get('SuccessfulExit')?.tag).toBe('false');
    expect(Number(dict.get('ThrottleInterval')?.text)).toBeGreaterThanOrEqual(10);
    expect(Number(dict.get('ThrottleInterval')?.text)).toBeLessThanOrEqual(30);
    expect(dict.get('WorkingDirectory')?.text).toBe('__REPO__');
    const args = dict.get('ProgramArguments')?.children.filter(node => node.tag === 'string').map(node => node.text);
    expect(args).toEqual([
      '__BUN__',
      '__REPO__/scripts/grok-shared-brain/cli-gate.ts',
      '--tokens',
      '__HOME__/.gbrain/serve/funnel-tokens.json',
      '--upstream',
      'http://127.0.0.1:8766',
      '--port',
      '8767',
    ]);
    expect(dict.get('StandardOutPath')?.text).toBe('__HOME__/Library/Logs/com.gbrain.funnel-gate.log');
    expect(dict.get('StandardErrorPath')?.text).toBe('__HOME__/Library/Logs/com.gbrain.funnel-gate.err');
    expect(template.includes('/bin/bash')).toBe(false);
    expect(template.includes('tailscale')).toBe(false);
    expect(template.includes('/Users/')).toBe(false);
  });

  test('filling the placeholders leaves a parseable agent with no leftovers', () => {
    const filled = template
      .split('__BUN__').join('/opt/bun/bun')
      .split('__REPO__').join('/opt/gbrain')
      .split('__HOME__').join('/opt/home');
    expect(filled.includes('__BUN__') || filled.includes('__REPO__') || filled.includes('__HOME__')).toBe(false);
    const dict = plistDict(parseXml(filled));
    const args = dict.get('ProgramArguments')?.children.filter(node => node.tag === 'string').map(node => node.text) ?? [];
    expect(args[0]).toBe('/opt/bun/bun');
    expect(args[1]).toBe('/opt/gbrain/scripts/grok-shared-brain/cli-gate.ts');
    expect(dict.get('WorkingDirectory')?.text).toBe('/opt/gbrain');
    expect(dict.get('StandardErrorPath')?.text.startsWith('/opt/home/Library/Logs/')).toBe(true);
  });
});

describe('host guard', () => {
  const short = shortHostname();

  test('parses host.env the way setup.sh does and names the machine on a mismatch', () => {
    expect(parseExpectedHost('# comment\n\nGBRAIN_EXPECTED_HOST="quoted-host"\n')).toBe('quoted-host');
    expect(parseExpectedHost('# only a comment\n')).toBeNull();
    expect(evaluateHostGuard(null, short).ok).toBe(false);
    const missingVar = evaluateHostGuard('GBRAIN_EXPECTED_HOST=\n', short);
    expect(missingVar.ok).toBe(false);
    if (!missingVar.ok) expect(missingVar.message).toContain('GBRAIN_EXPECTED_HOST is missing');
    const wrong = evaluateHostGuard('GBRAIN_EXPECTED_HOST=not-this-machine\n', short);
    expect(wrong).toEqual({ ok: false, status: 0, message: `Wrong machine: ${short}` });
    expect(evaluateHostGuard(`GBRAIN_EXPECTED_HOST=${short}\n`, short)).toEqual({ ok: true });
    const home = mkdtempSync(join(tmpdir(), 'gbrain-host-env-'));
    mkdirSync(join(home, '.gbrain', 'serve'), { recursive: true });
    const hostEnv = join(home, '.gbrain', 'serve', 'host.env');
    writeFileSync(hostEnv, `GBRAIN_EXPECTED_HOST=${short}\n`);
    expect(guardThisHost(home, short)).toEqual({ ok: true });
    writeFileSync(hostEnv, 'GBRAIN_EXPECTED_HOST=not-this-machine\n');
    expect(guardThisHost(home, short)).toEqual({ ok: false, status: 0, message: `Wrong machine: ${short}` });
  });

  test('cli-gate exits on the wrong machine before it listens', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gate-host-'));
    mkdirSync(join(home, '.gbrain', 'serve'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'serve', 'host.env'), 'GBRAIN_EXPECTED_HOST=not-this-machine\n');
    const ran = spawnSync(process.execPath, [join(SCRIPT_DIR, 'cli-gate.ts'), '--tokens', join(home, 'missing.json')], {
      encoding: 'utf8',
      timeout: 8_000,
      env: { ...process.env, HOME: home },
    });
    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain(`Wrong machine: ${short}`);
    expect(ran.stderr.includes('listening')).toBe(false);
  });

  test('an unreadable host.env is status 1 and does not throw a stack', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-host-unreadable-'));
    mkdirSync(join(home, '.gbrain', 'serve', 'host.env'), { recursive: true });
    const result = guardThisHost(home, short);
    expect(result).toEqual({ ok: false, status: 1, message: 'refusing: unreadable ~/.gbrain/serve/host.env' });
    expect(JSON.stringify(result).includes('\n')).toBe(false);
  });
});

describe('upstream token files', () => {
  test('the setter writes absolute paths, mode 0600, and the gate forwards access_token without logging it', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-upstream-files-'));
    const repo = repoRootFrom(import.meta.dir);
    const generated = generateTokens();
    const destination = join(scratch, 'funnel-tokens.json');
    writeTokenFile(destination, generated.config, repo);
    const grants = join(scratch, 'grants');
    mkdirSync(grants, { mode: 0o700 });
    const ran = spawnSync(process.execPath, [
      join(SCRIPT_DIR, 'cli-set-upstream-tokens.ts'),
      '--tokens', destination,
      '--grants', grants,
    ], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('updated upstream_token_file for personal, business, hermes');
    expect(ran.stdout.includes('access_token')).toBe(false);
    expect(ran.stderr.includes('access_token')).toBe(false);
    expect(statSync(destination).mode & 0o777).toBe(0o600);
    const parsed = parseFunnelConfig(JSON.parse(readFileSync(destination, 'utf8')));
    expect(parsed.clients.personal?.upstream_token_file).toBe(join(grants, 'personal.json'));
    expect(parsed.clients.business?.upstream_token_file).toBe(join(grants, 'business.json'));
    expect(parsed.clients.hermes?.upstream_token_file).toBe(join(grants, 'hermes.json'));
    expect(() => withUpstreamTokenFiles(generated.config, repo, repo)).toThrow(/outside the repo/);

    const grant = 'grant-credential-do-not-log';
    writeFileSync(join(grants, 'personal.json'), JSON.stringify({ access_token: grant }), { mode: 0o600 });
    const logs: string[] = [];
    const hits: string[] = [];
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(String(req.headers.authorization ?? ''));
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const server = createFunnelGate({
      config: parsed,
      upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      log: line => logs.push(line),
      repoRoot: repo,
    });
    const port = await listenGate(server);
    const response = await call(port, 'GET', '/health', generated.plaintext.personal);
    expect(response.status).toBe(200);
    expect(hits).toEqual([`Bearer ${grant}`]);
    const joined = logs.join('\n');
    expect(joined.includes(grant)).toBe(false);
    expect(joined.includes(generated.plaintext.personal)).toBe(false);
    expect(joined.toLowerCase().includes('authorization')).toBe(false);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
});

describe('gate stays up when upstream is down', () => {
  test('a bearer request is 502, the token is not logged, and the next request is proxied', async () => {
    const generated = generateTokens();
    const bearer = generated.plaintext.personal;
    const closed = createServer((_req, res) => { res.end(); });
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const logs: string[] = [];
    const gate = createFunnelGate({
      config: generated.config,
      upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      log: line => logs.push(line),
    });
    const port = await listenGate(gate);
    const down = await call(port, 'GET', '/health', bearer);
    expect(down.status).toBe(502);
    expect(down.text).toContain('bad_gateway');
    const joined = logs.join('\n');
    expect(joined.includes(bearer)).toBe(false);
    expect(joined.toLowerCase().includes('authorization')).toBe(false);
    expect(joined).toContain('status=502');

    const hits: string[] = [];
    const upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(String(req.headers.authorization ?? ''));
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(upstreamPort, '127.0.0.1', resolve);
    });
    const again = await call(port, 'GET', '/health', bearer);
    expect(again.status).toBe(200);
    expect(hits).toEqual(['']);
    expect(logs.join('\n').includes(bearer)).toBe(false);
    await new Promise<void>(resolve => gate.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  test('cli-gate listens while the upstream is down and does not log the bearer', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gate-up-'));
    const repo = repoRootFrom(import.meta.dir);
    mkdirSync(join(home, '.gbrain', 'serve'), { recursive: true });
    const short = shortHostname();
    writeFileSync(join(home, '.gbrain', 'serve', 'host.env'), `GBRAIN_EXPECTED_HOST=${short}\n`);
    const generated = generateTokens();
    const destination = join(home, 'funnel-tokens.json');
    writeTokenFile(destination, generated.config, repo);
    const closed = createServer((_req, res) => { res.end(); });
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    const child = spawn(process.execPath, [
      join(SCRIPT_DIR, 'cli-gate.ts'),
      '--tokens', destination,
      '--upstream', `http://127.0.0.1:${upstreamPort}`,
      '--port', '0',
    ], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const started = Date.now();
    while (!stderr.includes('listening on 127.0.0.1:') && Date.now() - started < 10_000) {
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    try {
      expect(child.exitCode).toBeNull();
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
      expect(match?.[1]).toBeTruthy();
      const response = await call(Number(match?.[1]), 'GET', '/health', generated.plaintext.personal);
      expect(response.status).toBe(502);
      expect(stderr.includes(generated.plaintext.personal)).toBe(false);
      expect(stderr.toLowerCase().includes('authorization')).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('launch agent docs', () => {
  test('install blocks are guarded and do not publish a hostname or a token', () => {
    const readme = readFileSync(join(import.meta.dir, '../docs/grok/shared-brain/README.md'), 'utf8');
    const section = readme.split('## LaunchAgent')[1]?.split('## Turn Funnel on')[0] ?? '';
    expect(section.length).toBeGreaterThan(0);
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1] ?? '');
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const block of blocks) {
      expect(block.startsWith('(\n. ~/.gbrain/serve/host.env || exit 1\n')).toBe(true);
      expect(block.trimEnd().endsWith(')')).toBe(true);
      expect(block).toContain('hostname -s');
      expect(block).toContain('"$host" != "$GBRAIN_EXPECTED_HOST"');
      expect(block).toContain('Wrong machine: $host');
      expect(block.indexOf('. ~/.gbrain/serve/host.env')).toBeLessThan(block.indexOf('set -euo pipefail') === -1 ? block.length : block.indexOf('set -euo pipefail'));
    }
    expect(section).toContain('REPO="$HOME/personalgrok/gbrain"');
    expect(section).toContain('checkout not found: $REPO/scripts/grok-shared-brain/cli-gate.ts');
    expect(section).toContain('cd "$REPO"');
    expect(section).toContain('--json >/dev/null');
    expect(section).toContain('echo "granted personal; private handoff is $HOME/.gbrain/serve/grants/personal.json"');
    expect(section.includes('Create that file first')).toBe(false);
    expect(section.includes('REPO="$HOME/gbrain"')).toBe(false);
    expect(section).toContain('gbrain mcp grant personal --harness grok-bot --profile memory-writer');
    expect(section).toContain('gbrain mcp grant business --harness grok-bot --profile memory-writer');
    expect(section).toContain('gbrain mcp grant hermes --harness grok-bot --profile memory-writer');
    expect(section).toContain('--credentials-out "$HOME/.gbrain/serve/grants/personal.json"');
    expect(section).toContain('chmod 700 "$HOME/.gbrain/serve/grants"');
    expect(section).toContain('chmod 600 "$HOME/.gbrain/serve/grants/personal.json"');
    expect(section).toContain('bun scripts/grok-shared-brain/cli-set-upstream-tokens.ts');
    expect(section).toContain("s#__BUN__#${BUN}#g");
    expect(section).toContain('FAIL: leftover placeholders');
    expect(section).toContain('plutil -lint');
    expect(section).toContain('launchctl bootout gui/$(id -u)/com.gbrain.funnel-gate || true');
    expect(section).toContain('launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.gbrain.funnel-gate.plist"');
    expect(section).toContain("launchctl print gui/$(id -u)/com.gbrain.funnel-gate | grep -E 'state|pid'");
    expect(section).toContain("curl -s -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8767/health");
    expect(section).toContain('Full Disk Access');
    expect(section).toContain('Network Volumes');
    expect(section.includes('/Users/')).toBe(false);
    for (const block of blocks) expect(block.includes('tailscale')).toBe(false);
    for (const file of readScriptTree(SCRIPT_DIR)) {
      expect(file.text.includes('tailscale serve')).toBe(false);
    }
  });
});

afterAll(() => {
  // scratch directories under tmpdir are left for the OS; nothing in the repo was written
  expect(existsSync(join(repoRootFrom(import.meta.dir), 'funnel-tokens.json'))).toBe(false);
});
