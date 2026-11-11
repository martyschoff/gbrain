/**
 * Offline tests for the shared-brain Funnel gate, token file, and index.lock clearer.
 * Listeners and the mock upstream bind 127.0.0.1 only.
 */
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BODY_LIMIT, createFunnelGate, listenGate } from '../scripts/grok-shared-brain/gate.ts';
import { clearStaleIndexLock, gitIsRunning, isGitComm, listLocalProcesses, parsePs, REFUSED_WITHOUT_FORCE, STALE_INDEX_LOCK_MS } from '../scripts/grok-shared-brain/index-lock.ts';
import { evaluateMcpBody } from '../scripts/grok-shared-brain/mcp-policy.ts';
import { findFunnelEnableInvocations, FUNNEL_ENABLE_COMMAND, readScriptTree, requestFunnelEnable } from '../scripts/grok-shared-brain/funnel-policy.ts';
import { authenticate, configContainsPlaintext, generateTokens, parseFunnelConfig, pathInside, repoRootFrom, sha256Hex, tokenMatchesHash, writeTokenFile, type FunnelConfig } from '../scripts/grok-shared-brain/tokens.ts';

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

  test('an oversize body is 413 and the socket stays open', async () => {
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
          'content-length': payload.length,
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

afterAll(() => {
  // scratch directories under tmpdir are left for the OS; nothing in the repo was written
  expect(existsSync(join(repoRootFrom(import.meta.dir), 'funnel-tokens.json'))).toBe(false);
});
