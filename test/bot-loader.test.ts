import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as files from '../scripts/bot-loader/files.ts';
import { loadConfig, assertRoutes } from '../scripts/bot-loader/config.ts';
import { createGbrainClient, manifestCounts, putArgv, addSourceArgv, spawnGbrain } from '../scripts/bot-loader/gbrain-client.ts';
import { shareIsMounted } from '../scripts/bot-loader/host.ts';
import { readManifest, writeManifest } from '../scripts/bot-loader/manifest.ts';
import { csvToMarkdown, renderPage, sha256 } from '../scripts/bot-loader/render.ts';
import { checkFailClosed } from '../scripts/bot-loader/fail-closed.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import { contentHasSecret, isSecretFileName } from '../scripts/bot-loader/secrets.ts';
import secretPatterns from '../scripts/bot-loader/secret-patterns.json';
import { slugFromRelative } from '../scripts/bot-loader/slug.ts';
import { formatSummary } from '../scripts/bot-loader/summary.ts';
import type { BrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import type { GroupConfig, LoaderConfig } from '../scripts/bot-loader/config.ts';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'scripts/bot-loader/cli.ts');
const BOX = join(REPO, 'scripts/bot-loader/box-export.py');
const INSTALL = join(REPO, 'scripts/bot-loader/install.sh');
const VERIFY = join(REPO, 'scripts/bot-loader/verify.sh');
const UNINSTALL = join(REPO, 'scripts/bot-loader/uninstall.sh');

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function hostName(): string {
  return spawnSync('hostname', ['-s'], { encoding: 'utf8' }).stdout.trim();
}

function baseConfig(home: string, share: string, extra: Record<string, unknown> = {}): LoaderConfig {
  const path = join(home, 'config.json');
  const body = {
    share_root: share,
    state_path: join(home, 'state.json'),
    summary_path: join(home, 'summary.txt'),
    lock_path: join(home, 'run.lock'),
    host_env: join(home, 'host.env'),
    gbrain_bin: '/usr/bin/gbrain',
    max_bytes: 1024,
    csv_max_rows: 1,
    box_export_max_age_hours: 36,
    box_export_dir: join(share, 'personalgrok/gbrain/_box-export'),
    groups: [
      {
        id: 'personal',
        source: 'personal',
        target_root: join(share, 'personalgrok/gbrain/personal'),
        ensure_source: false,
        forbid_git: false,
        extensions: ['.md', '.txt', '.json', '.yaml', '.yml'],
        bots: [
          {
            id: 'alpha',
            inputs: [
              { path: join(share, 'personalgrok/alpha'), required: false },
              { path: join(share, 'personalgrok/gbrain/_box-export/alpha'), required: false, role: 'box-export' },
            ],
          },
          {
            id: 'beta',
            inputs: [{ path: join(share, 'personalgrok/beta'), required: false }],
          },
        ],
      },
      {
        id: 'finance',
        source: 'finance',
        target_root: join(share, 'personalgrok/gbrain/finance'),
        ensure_source: true,
        forbid_git: true,
        extensions: ['.md', '.txt', '.json', '.csv', '.db'],
        bots: [
          {
          id: 'ledger',
          inputs: [
            { path: join(share, 'personalgrok/ledger'), required: false },
            { path: join(share, 'personalgrok/ledger/feeds'), required: false },
          ],
          },
        ],
      },
    ],
    ...extra,
  };
  writeFileSync(path, JSON.stringify(body));
  return loadConfig(path, home);
}

function fakeBrain(): { brain: BrainClient; puts: { source: string; slug: string; file: string; text: string; revision?: string }[] } {
  const puts: { source: string; slug: string; file: string; text: string; revision?: string }[] = [];
  const brain: BrainClient = {
    async ensureSource() { return { ok: true }; },
    async putPage(source, slug, file, revision) {
      puts.push({ source, slug, file, text: existsSync(file) ? readFileSync(file, 'utf8') : '', revision });
      return { ok: true, pending: false, revision: '00000000-0000-4000-8000-000000000001' };
    },
    async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
  };
  return { brain, puts };
}

describe('placeholders and routing', () => {
  test('example config uses placeholder bots and does not fix a bot count', () => {
    const home = temp('gbrain-loader-cfg-');
    const loaded = loadConfig(join(REPO, 'docs/grok/bot-loader/config.example.json'), home);
    const ids = loaded.groups.flatMap((group) => group.bots.map((bot) => bot.id));
    expect(ids).toEqual(['bot-a', 'bot-b', 'fin-bot']);
    expect(loaded.groups.find((group) => group.source === 'finance')?.extensions).toContain('.csv');
    expect(loaded.groups.find((group) => group.source === 'personal')?.extensions).not.toContain('.csv');
    const one = structuredClone(loaded);
    one.groups = [one.groups[0]!];
    one.groups[0]!.bots = [one.groups[0]!.bots[0]!];
    expect(() => assertRoutes(one.groups)).not.toThrow();
    expect(() => assertRoutes([{ id: 'finance', source: 'finance', targetRoot: join(home, 'personal') }])).toThrow(/finance/);
  });

  test('public files do not contain home-directory usernames, emails, or push commands', () => {
    const files = [
      'docs/grok/bot-loader/README.md',
      'docs/grok/bot-loader/config.example.json',
      'docs/grok/bot-loader/box-export.example.json',
      'scripts/bot-loader/install.sh',
      'scripts/bot-loader/cli.ts',
      'scripts/bot-loader/run.ts',
      'scripts/bot-loader/box-export.py',
      'scripts/bot-loader/com.gbrain.bot-loader.plist',
    ];
    for (const file of files) {
      const text = readFileSync(join(REPO, file), 'utf8');
      expect(text).not.toContain('/Users/');
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(text).not.toContain('git push');
      expect(text).not.toContain('commit-push');
    }
    const readme = readFileSync(join(REPO, 'docs/grok/bot-loader/README.md'), 'utf8');
    const install = readFileSync(INSTALL, 'utf8').trim();
    expect(readme).toContain(install);
    expect(readme).toContain('bash "$HOME/personalgrok/gbrain/scripts/bot-loader/verify.sh"');
    expect(readme.match(/verify\.sh/g)?.length).toBe(1);
    expect(readme).toContain('realpath "$HOME/.bun/bin/bun"');
    expect(readme).toContain('Full Disk Access');
  });
});

describe('classification', () => {
  test('slug, frontmatter, csv truncation, and secret patterns', () => {
    expect(slugFromRelative('Hello World.md')).toBe('hello-world');
    expect(isSecretFileName('.env')).toBe(true);
    expect(isSecretFileName('auth.json')).toBe(true);
    expect(isSecretFileName('id_rsa')).toBe(true);
    expect(isSecretFileName('notes.txt')).toBe(false);
    expect(contentHasSecret('prefix sk-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(contentHasSecret('plain note')).toBe(false);
    const csv = csvToMarkdown('h1,h2\n1,2\n3,4\n', 1);
    expect(csv.truncated).toBe(true);
    expect(csv.body).toContain('_Truncated after 1 data rows._');
    expect(csv.body).not.toContain('3,4');
    const page = renderPage({ relativeMd: 'bot-a/note.md', title: 'note', originRelpath: 'personalgrok/bot-a/note.md', originSha256: 'abc', body: 'hello\n' });
    expect(page).toContain('slug: bot-a/note');
    expect(page).toContain('origin_sha256: "abc"');
    expect(formatSummary({
      ok: true,
      bots: [{ id: 'bot-a', source: 'personal', scanned: 1, written: 1, unchanged: 0, skipped: 0, secretsSkipped: 0, pages: 4 }],
      sources: [{ id: 'personal', pages: 4, via: 'pages written by the loader (manifest)' }],
      orphans: [{ bot: 'alpha', count: 2 }],
      warnings: ['box-export stale'],
    })).toBe([
      'bot-loader: ok',
      'bot bot-a source=personal scanned=1 written=1 unchanged=0 skipped=0 secrets_skipped=0 pages=4',
      'source personal pages=4 via=pages written by the loader (manifest)',
      'orphaned alpha 2',
      'WARN box-export stale',
      '',
    ].join('\n'));
  });

  test('put argv stays on the group source and never delegates away from the owner', () => {
    expect(putArgv('gbrain', 'finance', 'fin-bot/feeds/prices', '/tmp/prices.md')).toEqual([
      'gbrain', 'put', 'fin-bot/feeds/prices', '--source', 'finance', '--file', '/tmp/prices.md', '--json',
    ]);
    expect(putArgv('gbrain', 'finance', 'fin-bot/feeds/prices', '/tmp/prices.md', '00000000-0000-4000-8000-000000000001')).toEqual([
      'gbrain', 'put', 'fin-bot/feeds/prices', '--source', 'finance', '--file', '/tmp/prices.md',
      '--expected-revision', '00000000-0000-4000-8000-000000000001', '--json',
    ]);
    expect(addSourceArgv('gbrain', 'finance', '/tmp/finance').join(' ')).not.toContain('--url');
    expect(addSourceArgv('gbrain', 'finance', '/tmp/finance')).toContain('--force');
    const recorded: string[][] = [];
    const client = createGbrainClient('/usr/bin/gbrain', async (argv) => {
      recorded.push(argv);
      if (argv.includes('stats') || argv.includes('list')) throw new Error('stats and list must not run');
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    return client.ensureSource('finance', '/tmp/finance').then(async () => {
      expect((await client.putPage('finance', 'ledger/feeds/prices', '/tmp/prices.md')).ok).toBe(true);
      const failed = createGbrainClient('/usr/bin/gbrain', async () => ({ code: 1, stdout: '', stderr: '' }));
      expect(await failed.putPage('finance', 'ledger/failed', '/tmp/failed.md')).toEqual({ ok: false, pending: false, detail: 'exit 1' });
      const occupied = createGbrainClient('/usr/bin/gbrain', async () => ({
        code: 1,
        stdout: '{"code":"source_changed","message":"An unindexed file already occupies /home/acct-example/note.md"}',
        stderr: 'Error [source_changed]: /home/acct-example/note.md',
      }));
      const refused = await occupied.putPage('finance', 'ledger/occupied', '/tmp/occupied.md');
      expect(refused.ok).toBe(false);
      expect(refused.pending).toBe(false);
      expect(refused.code).toBe('source_changed');
      expect(refused.detail).toContain('exit 1, source_changed');
      expect(refused.detail).not.toContain('acct-example');
      expect(refused.detail).not.toContain('/home');
      const pending = createGbrainClient('/usr/bin/gbrain', async () => ({ code: 10, stdout: '', stderr: '' }));
      expect(await pending.putPage('finance', 'ledger/pending', '/tmp/pending.md')).toEqual({ ok: false, pending: true });
      const kept = join(temp('gbrain-count-'), 'kept.md');
      write(kept, 'kept\n');
      const missing = join(kept, '..', 'missing.md');
      const counts = await client.counts(['finance'], [{ source: 'finance', bot: 'ledger' }], {
        version: 1,
        files: {
          [kept]: { sha256: 'a', bot: 'ledger', source: 'finance', slug: 'ledger/kept', output: '/out/kept.md', originRelpath: 'kept.md', inBrain: true },
          [missing]: { sha256: 'b', bot: 'ledger', source: 'finance', slug: 'ledger/missing', output: '/out/missing.md', originRelpath: 'missing.md', inBrain: true },
          '/src/failed.md': { sha256: 'c', bot: 'ledger', source: 'finance', slug: 'ledger/failed', output: '/out/failed.md', originRelpath: 'failed.md', inBrain: false },
          '/src/wait.md': { sha256: 'd', bot: 'ledger', source: 'finance', slug: 'ledger/wait', output: '/out/wait.md', originRelpath: 'wait.md', inBrain: false, pending: true },
          '/src/gone.md': { sha256: 'e', bot: 'retired', source: 'finance', slug: 'retired/gone', output: '/out/gone.md', originRelpath: 'gone.md', inBrain: true },
        },
      });
      expect(counts.sources.finance).toBe(1);
      expect(counts.bots['finance/ledger']).toBe(1);
      expect(counts.via).toBe('pages written by the loader (manifest)');
      expect(recorded.some((argv) => argv.includes('stats') || argv.includes('list') || argv.includes('--no-delegate') || argv.includes('push'))).toBe(false);
    });
  });
});

describe('cli failure diagnostics', () => {
  test('a uuid revision is parsed from raw stdout before redaction', async () => {
    const rev = '11111111-2222-4333-8444-555555555555';
    const home = temp('gbrain-loader-uuid-');
    const bin = join(home, 'gbrain-bin');
    writeFileSync(bin, `#!/bin/bash\nprintf '%s' '{"ok":true,"revision":"${rev}"}'\n`);
    chmodSync(bin, 0o755);
    const client = createGbrainClient(bin);
    const put = await client.putPage('personal', 'alpha/note', join(home, 'note.md'));
    expect(put.ok).toBe(true);
    expect(put.revision).toBe(rev);
    const read = await client.getRevision!('personal', 'alpha/note');
    expect(read).toEqual({ ok: true, revision: rev });
    const spawned = await spawnGbrain([bin, 'put', 'alpha/note', '--json']);
    expect(spawned.revision).toBe(rev);
    expect(spawned.stdout).not.toContain(rev);
    expect(spawned.stdout).toContain('[redacted]');
  });

  test('a hung child is killed at the timeout and the loader lock is released', async () => {
    const hung = await spawnGbrain([process.execPath, '-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
    expect(hung.timedOut).toBe(true);
    const client = createGbrainClient('/usr/bin/gbrain', async () => hung);
    const put = await client.putPage('personal', 'alpha/note', '/tmp/note.md');
    expect(put.ok).toBe(false);
    expect(put.pending).toBe(false);
    expect(put.detail).toContain('timeout');
    expect(put.detail).not.toContain('/tmp/note.md');

    const home = temp('gbrain-loader-timeout-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'keep\n');
    const config = baseConfig(home, share);
    const slow = createGbrainClient(process.execPath, () => spawnGbrain(
      [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
      { timeoutMs: 200 },
    ));
    const failed = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: slow, now: new Date('2026-11-11T00:00:00Z') });
    expect(failed.exitCode).toBe(1);
    expect(failed.summaryText).toContain('timeout');
    const next = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain: fakeBrain().brain,
      now: new Date('2026-11-11T01:00:00Z'),
    });
    expect(next.exitCode).toBe(0);
  });

  const stamp = '2026-11-12T02:00:00-05:00';
  const token = 'b'.repeat(40);

  function writeDrop(dir: string): void {
    const files: Record<string, string> = {
      'profile.json': '{"id":"bot-a","name":"Bot A"}\n',
      'memory.md': '# Memory\n\n## 2026-11-12\n\nA fake fact.\n',
      'routines.md': '# Routines\n\n## morning\n\n- schedule: 0 2 * * *\n- prompt: Summarize the day.\n',
    };
    const listed: Record<string, { size: number; sha256: string }> = {};
    for (const [rel, text] of Object.entries(files)) {
      write(join(dir, rel), text);
      const buf = Buffer.from(text);
      listed[rel] = { size: buf.length, sha256: sha256(buf) };
    }
    write(join(dir, 'manifest.json'), `${JSON.stringify({
      version: 1,
      bot_name: 'Bot A',
      bot_id: 'bot-a',
      account: 'account-a',
      exported_at: stamp,
      files: listed,
    })}\n`);
  }

  test('ensureSource failure names the exit code and redacts a long stderr token', async () => {
    const home = temp('gbrain-loader-src-fail-');
    const share = join(home, 'share');
    writeDrop(join(share, 'drops', '_box-export', 'bot-a'));
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const config = baseConfig(home, share, {
      export_roots: [{
        account: 'account-a',
        path: join(share, 'drops', '_box-export'),
        source: 'account-a',
        target_root: join(share, 'pages-a'),
        ensure_source: true,
      }],
    });
    const brain = createGbrainClient('/usr/bin/gbrain', async (argv) => {
      if (argv[3] === 'account-a') {
        return {
          code: 1,
          stdout: JSON.stringify({
            code: 'writer_manifest_unsafe',
            message: `checkout refused ${token}`,
            suggestion: 'inspect the checkout',
          }),
          stderr: `refused ${token}\n`,
        };
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    const direct = await brain.ensureSource('account-a', join(share, 'pages-a')) as { ok: boolean; detail?: string };
    expect(direct.ok).toBe(false);
    expect(direct.detail).toContain('exit 1');
    expect(direct.detail).toContain('writer_manifest_unsafe');
    expect(direct.detail).toContain('[redacted]');
    expect(direct.detail).not.toContain(token);
    expect(direct.detail).not.toContain('inspect the checkout');
    const result = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain,
      now: new Date('2026-11-12T12:00:00Z'),
    });
    expect(result.summaryText).toContain('WARN export account-a: source not created (exit 1, writer_manifest_unsafe:');
    expect(result.summaryText).not.toContain(token);
    expect(result.summaryText).not.toContain('A fake fact');
    expect(readFileSync(config.summaryPath, 'utf8')).toContain('exit 1, writer_manifest_unsafe');
    const exists = createGbrainClient('/usr/bin/gbrain', async () => ({ code: 1, stdout: '', stderr: 'source already exists\n' }));
    expect((await exists.ensureSource('finance', '/tmp/finance')).ok).toBe(true);
  });

  test('putPage failure names the exit code on the warning', async () => {
    const home = temp('gbrain-loader-put-fail-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'acct-example/alpha/note.md'), 'hello from the note\n');
    const config = baseConfig(home, share, {
      groups: [{
        id: 'personal',
        source: 'personal',
        target_root: join(share, 'acct-example/gbrain/personal'),
        ensure_source: false,
        forbid_git: false,
        extensions: ['.md'],
        bots: [{
          id: 'alpha',
          inputs: [{ path: join(share, 'acct-example/alpha'), required: false }],
        }],
      }],
    });
    const brain = createGbrainClient('/usr/bin/gbrain', async (argv) => {
      if (argv.includes('put')) {
        return {
          code: 1,
          stdout: JSON.stringify({ code: 'live_serve', message: 'the brain is busy', suggestion: 'retry later' }),
          stderr: 'Error [live_serve]: the brain is busy\n',
        };
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    const put = await brain.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(put).toMatchObject({ ok: false, pending: false });
    expect(put.detail).toContain('exit 1');
    expect(put.detail).toContain('live_serve');
    expect(put.detail).toContain('the brain is busy');
    expect(put.detail).not.toContain('retry later');
    const result = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain,
      now: new Date('2026-11-12T12:00:00Z'),
    });
    expect(result.summaryText).toContain('WARN put failed alpha/note (exit 1, live_serve: the brain is busy)');
    expect(result.summaryText).not.toContain('hello from the note');
    expect(readFileSync(config.summaryPath, 'utf8')).toContain('put failed alpha/note');
  });

  test('putPage keeps one redacted stderr line and drops stdout', async () => {
    const noise = 'c'.repeat(40);
    const page = 'page body that must stay out\n';
    const client = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 2,
      stdout: page,
      stderr: `gbrain: source directory is not writable ${noise}\nsecond line stays off the warning\n`,
    }));
    const put = await client.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(put).toMatchObject({ ok: false, pending: false });
    expect(put.detail).toContain('exit 2');
    expect(put.detail).toContain('source directory is not writable');
    expect(put.detail).not.toContain(page.trim());
    expect(put.detail).not.toContain('second line stays off');
    expect(put.detail).not.toContain(noise);
    expect(put.detail).toContain('[redacted]');
  });

  test('diagnostics redact a short token, a url, an email, and a home path', async () => {
    const shortToken = 'abcdefghijklmnop';
    const page = 'stdout is the page body\n';
    const stderr = [
      `auth failed https://user-example:x@host.example/db?access_token=${shortToken} user-example@mail.example Cannot read /home/user-example/note.md`,
      'second-line-marker',
    ].join('\n');
    const client = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: page,
      stderr,
    }));
    const put = await client.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(put.detail).toContain('exit 1');
    expect(put.detail).toContain('auth failed');
    expect(put.detail).toContain('~/note.md');
    expect(put.detail).not.toContain(shortToken);
    expect(put.detail).not.toContain('user-example');
    expect(put.detail).not.toContain('mail.example');
    expect(put.detail).not.toContain('/home/');
    expect(put.detail).not.toContain(page.trim());
    expect(put.detail).not.toContain('second-line-marker');
  });

  test('a numeric JSON code falls back to stderr and a second object is ignored', async () => {
    const client = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 4,
      stdout: '{"code":1,"message":"numeric code message"}\n{"argv":["token-example-should-not-leak"]}\n',
      stderr: 'caller rejected the write\n',
    }));
    const numeric = await client.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(numeric).toMatchObject({ ok: false, pending: false });
    expect(numeric.detail).toContain('exit 4');
    expect(numeric.detail).toContain('caller rejected the write');
    expect(numeric.detail).not.toContain('numeric code message');
    expect(numeric.detail).not.toContain('token-example-should-not-leak');

    const wrapped = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: 'note {"code":"live_serve","message":"busy"} trailing {"argv":["also-not-logged"]}',
      stderr: '',
    }));
    const parsed = await wrapped.ensureSource('finance', '/tmp/finance') as { ok: boolean; detail?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain('exit 1, live_serve: busy');
    expect(parsed.detail).not.toContain('also-not-logged');
    expect(parsed.detail).not.toContain('trailing');
  });

  test('a kill signal is named and a huge pipe is capped before redaction', async () => {
    const killed = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      signal: 'SIGTERM',
      stdout: 'should-not-copy-stdout',
      stderr: 'terminated\n',
    }));
    const put = await killed.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(put.detail).toContain('killed SIGTERM');
    expect(put.detail).toContain('terminated');
    expect(put.detail).not.toContain('should-not-copy-stdout');
    expect(put.detail).not.toContain('exit 1');

    const token = 'd'.repeat(40);
    const result = await spawnGbrain([
      process.execPath,
      '-e',
      `/* argv-marker-zz */ process.stdout.write(${JSON.stringify(token)} + ' ' + 'A '.repeat(10000)); process.stderr.write('B '.repeat(10000)); process.kill(process.pid, 'SIGKILL');`,
    ]);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stdout.length).toBeLessThanOrEqual(8192);
    expect(result.stderr.length).toBeLessThanOrEqual(8192);
    expect(result.stdout.length).toBeGreaterThan(1000);
    expect(result.stdout).not.toContain(token);
    expect(result.stdout).toContain('[redacted]');
    expect(result.stdout).not.toContain('argv-marker-zz');
    expect(result.stderr).not.toContain('argv-marker-zz');
  });

  test('mid-line assignments, a short bearer, and a windows user path are redacted', async () => {
    const client = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'login failed password=abcdefgh token=tokentok api_key: keykeykey passwd=passpass secret: secsecsec\n',
    }));
    const put = await client.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(put.detail).toContain('exit 1');
    expect(put.detail).toContain('login failed');
    expect(put.detail).not.toContain('abcdefgh');
    expect(put.detail).not.toContain('tokentok');
    expect(put.detail).not.toContain('keykeykey');
    expect(put.detail).not.toContain('passpass');
    expect(put.detail).not.toContain('secsecsec');

    const upper = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'auth PASSWORD: hunter2\n',
    }));
    const password = await upper.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(password.detail).toContain('auth');
    expect(password.detail).not.toContain('hunter2');

    const header = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'Authorization: Bearer abc.def\n',
    }));
    const bearer = await header.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(bearer.detail).toContain('Bearer [redacted]');
    expect(bearer.detail).not.toContain('abc.def');

    const paths = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'Cannot read C:\\Users\\user-example\\x and D:/Users/user-example/note.md\n',
    }));
    const windows = await paths.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(windows.detail).toContain('~\\x');
    expect(windows.detail).toContain('~/note.md');
    expect(windows.detail).not.toContain('user-example');
  });

  test('quoted assignment values, api key spellings, and phrase colons stay precise', async () => {
    const quoted = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'token="quoted value with spaces" password=\'abc def\'\n',
    }));
    const quotePut = await quoted.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(quotePut.detail).not.toContain('quoted value');
    expect(quotePut.detail).not.toContain('with spaces');
    expect(quotePut.detail).not.toContain('abc def');
    expect(quotePut.detail).not.toContain("def'");
    expect(quotePut.detail).toContain('[redacted]');

    const aliases = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'login failed api-key=hyphenval apiKey: camelval APIKEY=upperval\n',
    }));
    const aliasPut = await aliases.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(aliasPut.detail).toContain('login failed');
    expect(aliasPut.detail).not.toContain('hyphenval');
    expect(aliasPut.detail).not.toContain('camelval');
    expect(aliasPut.detail).not.toContain('upperval');

    const phrase = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'invalid token: missing\n',
    }));
    const phrasePut = await phrase.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(phrasePut.detail).toContain('invalid token: missing');
    expect(phrasePut.detail).not.toContain('[redacted]');

    const query = createGbrainClient('/usr/bin/gbrain', async () => ({
      code: 1,
      stdout: '',
      stderr: 'failed ?token=querytok&x=1\n',
    }));
    const queryPut = await query.putPage('personal', 'alpha/note', '/tmp/note.md') as { ok: boolean; pending: boolean; detail?: string };
    expect(queryPut.detail).toContain('&x=1');
    expect(queryPut.detail).toContain('token=[redacted]');
    expect(queryPut.detail).not.toContain('querytok');
  });

  test('assignments are quote-aware and fail closed', async () => {
    const detailOf = async (stderr: string): Promise<string> => {
      const client = createGbrainClient('/usr/bin/gbrain', async () => ({ code: 1, stdout: '', stderr }));
      const put = await client.putPage('personal', 'alpha/note', '/tmp/note.md') as { detail?: string };
      return put.detail ?? '';
    };

    for (const line of ['auth token: abc123\n', 'bearer token: abc123\n', 'error, token: abc123\n', 'invalid\ttoken: abc123\n']) {
      const detail = await detailOf(line);
      expect(detail).not.toContain('abc123');
      expect(detail).toContain('[redacted]');
    }
    const phrase = await detailOf('invalid token: missing\n');
    expect(phrase).toContain('invalid token: missing');
    expect(phrase).not.toContain('[redacted]');

    for (const line of ["password='abc def'\n", 'PASSWORD="abc def"\n', "api-key='abc def'\n", 'api_key="abc def"\n']) {
      const detail = await detailOf(line);
      expect(detail).toBe('exit 1, [redacted]');
    }

    expect(await detailOf('token="abc def\n')).toBe('exit 1, [redacted]');
    expect(await detailOf('token="abc\\"def"\n')).toBe('exit 1, [redacted]');
    expect(await detailOf('token=`abc def`\n')).toBe('exit 1, [redacted]');

    const joined = await detailOf('secret=foo&bar\n');
    expect(joined).toBe('exit 1, [redacted]');
    expect(joined).not.toContain('&bar');

    const started = performance.now();
    const bulky = await detailOf(`token=abc ${'x '.repeat(50000)}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(bulky).not.toContain('token=abc');
    expect(bulky).toContain('[redacted]');
  });
});

describe('secret list', () => {
  test('every shared name and content pattern has a positive and a negative', () => {
    for (const row of secretPatterns.names) expect(isSecretFileName(row.sample)).toBe(true);
    for (const name of secretPatterns.name_negatives) expect(isSecretFileName(name)).toBe(false);
    for (const row of secretPatterns.content) expect(contentHasSecret(row.sample)).toBe(true);
    for (const text of secretPatterns.content_negatives) expect(contentHasSecret(text)).toBe(false);
    const python = spawnSync('python3', ['test_secret_rules.py'], { cwd: join(REPO, 'scripts/bot-loader'), encoding: 'utf8' });
    expect(python.status).toBe(0);
  });
});

describe('loader run', () => {
  test('allowlist, secrets, finance routing, idempotency, orphans, and summary', async () => {
    const home = temp('gbrain-loader-run-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/Hello World.md');
    write(note, '---\nslug: hijack\n---\nHello from alpha\n');
    write(join(share, 'personalgrok/alpha/skip.png'), 'not-an-image');
    write(join(share, 'personalgrok/alpha/secret.txt'), 'sk-abcdefghijklmnopqrstuvwxyz\n');
    write(join(share, 'personalgrok/alpha/.env'), 'X=1\n');
    write(join(share, 'personalgrok/alpha/automations/plan.md'), 'do not read\n');
    write(join(share, 'personalgrok/alpha/only.csv'), 'h\n1\n');
    write(join(share, 'personalgrok/alpha/notes.txt'), 'The token in this sentence is a word.\n');
    write(join(share, 'personalgrok/beta/other.txt'), 'beta note\n');
    write(join(share, 'personalgrok/ledger/feeds/prices.csv'), 'h1,h2\n1,2\n3,4\n');
    write(join(share, 'personalgrok/ledger/cache.db'), 'sqlite-bytes');
    const before = statSync(note).mtimeMs;
    const config = baseConfig(home, share);
    const { brain, puts } = fakeBrain();
    const first = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(first.exitCode).toBe(0);
    expect(first.summaryText).toContain('bot alpha source=personal');
    expect(first.summaryText).toContain('secrets_skipped=2');
    expect(first.summaryText).toContain('bot ledger source=finance');
    expect(first.summaryText).toContain('source finance pages=1 via=pages written by the loader (manifest)');
    expect(first.summaryText).toContain('source personal pages=3 via=pages written by the loader (manifest)');
    expect(first.summaryText).toContain('WARN box-export missing');
    expect(first.summaryText).not.toContain('sk-abc');
    expect(first.summaryText).not.toContain('Hello from alpha');
    expect(first.summaryText).not.toContain('[redacted]');
    const personalRoot = join(share, 'personalgrok/gbrain/personal');
    const financeRoot = join(share, 'personalgrok/gbrain/finance');
    const staged = (slug: string) => puts.find((put) => put.slug === slug)?.text ?? '';
    expect(existsSync(join(personalRoot, 'alpha/hello-world.md'))).toBe(false);
    expect(existsSync(join(financeRoot, 'ledger/feeds/prices.md'))).toBe(false);
    expect(existsSync(join(personalRoot, 'alpha/only.md'))).toBe(false);
    expect(existsSync(join(financeRoot, 'ledger/cache.md'))).toBe(false);
    expect(existsSync(join(personalRoot, 'alpha/automations/plan.md'))).toBe(false);
    expect(existsSync(join(personalRoot, 'alpha/secret.md'))).toBe(false);
    const notesPage = staged('alpha/notes');
    expect(notesPage).toContain('The token in this sentence is a word.');
    expect(notesPage).not.toContain('[redacted]');
    const page = staged('alpha/hello-world');
    expect(page).toContain('slug: alpha/hello-world');
    expect(page).toContain(`origin_sha256: "${sha256(readFileSync(note))}"`);
    expect(page).toContain('origin_relpath: "personalgrok/alpha/Hello World.md"');
    expect(page).not.toContain('slug: hijack');
    expect(staged('ledger/feeds/prices')).toContain('_Truncated after 1 data rows._');
    expect(puts.map((put) => put.source).sort()).toEqual(['finance', 'personal', 'personal', 'personal']);
    expect(puts.every((put) => !put.file.startsWith(personalRoot) && !put.file.startsWith(financeRoot))).toBe(true);
    expect(puts.every((put) => put.revision === undefined)).toBe(true);
    expect(statSync(note).mtimeMs).toBe(before);
    expect(statSync(join(home, 'state.json')).mode & 0o777).toBe(0o600);

    const second = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T01:00:00Z') });
    expect(second.exitCode).toBe(0);
    expect(second.summaryText).toContain('bot alpha source=personal scanned=6 written=0 unchanged=2 skipped=2 secrets_skipped=2');
    expect(second.summaryText).toContain('bot ledger source=finance scanned=2 written=0 unchanged=1 skipped=1 secrets_skipped=0');
    expect(puts).toHaveLength(4);

    const removed = readFileSync(note, 'utf8');
    writeFileSync(note, removed);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(note);
    const kept = join(share, 'personalgrok/gbrain/personal/alpha/hello-world.md');
    write(kept, 'left on disk\n');
    const third = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T02:00:00Z') });
    expect(third.summaryText).toContain('orphaned alpha 1');
    expect(third.summaryText).toContain('bot alpha source=personal scanned=5 written=0 unchanged=1 skipped=2 secrets_skipped=2 pages=1');
    expect(third.summaryText).toContain('source personal pages=2 via=pages written by the loader (manifest)');
    expect(readFileSync(kept, 'utf8')).toBe('left on disk\n');
    expect(puts).toHaveLength(4);
    expect(readManifest(join(home, 'state.json')).files[note]?.originRelpath).toContain('Hello World.md');
  });

  test('stale box export and missing optional or required inputs warn and still exit 0', async () => {
    const home = temp('gbrain-loader-warn-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const stampDir = join(share, 'personalgrok/gbrain/_box-export');
    write(join(stampDir, 'EXPORTED_AT'), '2020-01-01T00:00:00Z\nalpha 1\n');
    write(join(stampDir, 'alpha/from-box.md'), 'from box\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'from share\n');
    const config = baseConfig(home, share);
    config.groups[0]!.bots[0]!.inputs.push({ path: join(share, 'missing-optional'), required: false });
    config.groups[0]!.bots[0]!.inputs.push({ path: join(share, 'missing-required'), required: true });
    const { brain } = fakeBrain();
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('WARN box-export stale');
    expect(result.summaryText).toContain('WARN optional input missing bot=alpha');
    expect(result.summaryText).toContain('WARN required input missing bot=alpha');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/from-box.md'))).toBe(false);
  });

  test('host mismatch exits 0 and an unmounted share or a held lock changes nothing', async () => {
    const home = temp('gbrain-loader-guard-');
    const share = join(home, 'share');
    mkdirSync(share, { recursive: true });
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const config = baseConfig(home, share);
    const marker = join(share, 'marker.txt');
    writeFileSync(marker, 'unchanged\n');
    const mismatch = await runLoader({
      config,
      hostname: 'other-host',
      isMounted: () => { throw new Error('should not check the mount'); },
      brain: fakeBrain().brain,
    });
    expect(mismatch.exitCode).toBe(0);
    expect(mismatch.summaryText).toContain('bot-loader: skipped: wrong host');
    expect(mismatch.summaryText).toContain('WARN hostname does not match GBRAIN_EXPECTED_HOST');
    expect(readFileSync(config.summaryPath, 'utf8')).toContain('skipped: wrong host');
    expect(existsSync(join(home, 'state.json'))).toBe(false);

    const unmounted = await runLoader({ config, hostname: 'test-host', isMounted: () => false, brain: fakeBrain().brain });
    expect(unmounted.exitCode).toBe(1);
    expect(existsSync(join(home, 'state.json'))).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('unchanged\n');
    expect(shareIsMounted(share)).toBe(false);

    writeFileSync(config.lockPath, `${process.pid}\n`);
    const locked = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
    expect(locked.exitCode).toBe(1);
    expect(existsSync(join(home, 'state.json'))).toBe(false);
  });

  test('finance git metadata is not imported into personal', async () => {
    const home = temp('gbrain-loader-git-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'keep\n');
    write(join(share, 'personalgrok/ledger/feed.md'), 'numbers\n');
    const clean = join(share, 'personalgrok/gbrain/finance');
    mkdirSync(clean, { recursive: true });
    expect(spawnSync('git', ['init'], { cwd: clean }).status).toBe(0);
    const config = baseConfig(home, share);
    const open = fakeBrain();
    const allowed = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: open.brain });
    expect(allowed.exitCode).toBe(0);
    expect(open.puts.some((put) => put.source === 'finance')).toBe(true);
    expect(open.puts.find((put) => put.source === 'finance')!.text).toContain('numbers');
    expect(existsSync(join(clean, 'ledger/feed.md'))).toBe(false);

    expect(spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/finance.git'], { cwd: clean }).status).toBe(0);
    const blocked = fakeBrain();
    const refused = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: blocked.brain });
    expect(refused.exitCode).toBe(1);
    expect(refused.summaryText).toContain('source finance has a git remote; refusing to write');
    expect(blocked.puts).toEqual([]);
    expect(open.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('keep');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
  });

  test('a clean file containing an xoxb token is not written or queued', async () => {
    const home = temp('gbrain-loader-xoxb-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/alpha/meeting.md'), 'prefix xoxb-FAKEFAKEFAKE\n');
    const config = baseConfig(home, share);
    const { brain, puts } = fakeBrain();
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bot alpha source=personal scanned=1 written=0 unchanged=0 skipped=0 secrets_skipped=1');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/meeting.md'))).toBe(false);
    expect(puts).toHaveLength(0);
  });

  test('forbidGit true checks remotes and forbidGit false does not', async () => {
    const home = temp('gbrain-loader-forbid-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'keep\n');
    write(join(share, 'personalgrok/ledger/feed.md'), 'numbers\n');
    const personal = join(share, 'personalgrok/gbrain/personal');
    const finance = join(share, 'personalgrok/gbrain/finance');
    mkdirSync(personal, { recursive: true });
    mkdirSync(finance, { recursive: true });
    expect(spawnSync('git', ['init'], { cwd: personal }).status).toBe(0);
    expect(spawnSync('git', ['init'], { cwd: finance }).status).toBe(0);
    expect(spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/personal.git'], { cwd: personal }).status).toBe(0);
    expect(spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/finance.git'], { cwd: finance }).status).toBe(0);
    const config = baseConfig(home, share);
    expect(config.groups.find((group) => group.source === 'personal')?.forbidGit).toBe(false);
    expect(config.groups.find((group) => group.source === 'finance')?.forbidGit).toBe(true);
    const { brain, puts } = fakeBrain();
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
    expect(result.exitCode).toBe(1);
    expect(result.summaryText).toContain('source finance has a git remote; refusing to write');
    expect(puts.map((put) => put.source)).toEqual(['personal']);
    expect(puts[0]!.text).toContain('keep');
    expect(existsSync(join(personal, 'alpha/local.md'))).toBe(false);
    expect(existsSync(join(finance, 'ledger/feed.md'))).toBe(false);
  });
});

  test('a per-bot drop does not warn that the top-level stamp is missing', async () => {
    const home = temp('gbrain-loader-per-bot-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/gbrain/_box-export/alpha/manifest.json'), '{}\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'from share\n');
    const config = baseConfig(home, share);
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).not.toContain('box-export stamp missing');
    expect(result.summaryText).not.toContain('box-export missing');

    const flat = temp('gbrain-loader-flat-stamp-');
    const flatShare = join(flat, 'share');
    writeFileSync(join(flat, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    mkdirSync(join(flatShare, 'personalgrok/gbrain/_box-export'), { recursive: true });
    write(join(flatShare, 'personalgrok/alpha/local.md'), 'from share\n');
    const flatResult = await runLoader({
      config: baseConfig(flat, flatShare),
      hostname: 'test-host',
      isMounted: () => true,
      brain: fakeBrain().brain,
      now: new Date('2026-11-11T00:00:00Z'),
    });
    expect(flatResult.summaryText).toContain('WARN box-export stamp missing');
  });

  test('a changed page sends the stored revision and a conflict skips', async () => {
    const home = temp('gbrain-loader-rev-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/note.md');
    write(note, 'first text\n');
    const config = baseConfig(home, share);
    const rev = '00000000-0000-4000-8000-0000000000aa';
    const puts: { slug: string; revision?: string }[] = [];
    let conflict = false;
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage(_source, slug, _file, revision) {
        puts.push({ slug, revision });
        if (conflict && slug === 'alpha/note') {
          return { ok: false, pending: false, code: 'revision_conflict', detail: 'exit 1, revision_conflict' };
        }
        return { ok: true, pending: false, revision: rev };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const first = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(first.exitCode).toBe(0);
    expect(puts.find((put) => put.slug === 'alpha/note')?.revision).toBeUndefined();
    expect(readManifest(join(home, 'state.json')).files[note]?.revision).toBe(rev);
    write(note, 'second text\n');
    const second = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T01:00:00Z') });
    expect(second.exitCode).toBe(0);
    expect(puts.filter((put) => put.slug === 'alpha/note').at(-1)?.revision).toBe(rev);
    conflict = true;
    write(note, 'third text\n');
    const third = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T02:00:00Z') });
    expect(third.exitCode).toBe(1);
    expect(third.summaryText).toContain('WARN put failed alpha/note skipped (exit 1, revision_conflict)');
    expect(readManifest(join(home, 'state.json')).files[note]?.revision).toBe(rev);
    expect(third.summaryText).not.toContain('--force');
  });

  test('revision_required reads the revision once and a second conflict is a failure', async () => {
    const home = temp('gbrain-loader-revreq-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/note.md');
    write(note, 'first text\n');
    const config = baseConfig(home, share);
    const rev = '00000000-0000-4000-8000-0000000000cc';
    const puts: { revision?: string }[] = [];
    let reads = 0;
    let mode: 'required' | 'ok' | 'conflict' = 'required';
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage(_source, _slug, _file, revision) {
        puts.push({ revision });
        if (mode === 'required' && revision === undefined) {
          return { ok: false, pending: false, code: 'revision_required', detail: 'exit 1, revision_required' };
        }
        if (mode === 'conflict') {
          return { ok: false, pending: false, code: 'revision_conflict', detail: 'exit 1, revision_conflict' };
        }
        return { ok: true, pending: false, revision: rev };
      },
      async getRevision() {
        reads++;
        return { ok: true, revision: rev };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const first = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(first.exitCode).toBe(0);
    expect(reads).toBe(1);
    expect(puts.map((put) => put.revision)).toEqual([undefined, rev]);
    expect(readManifest(config.statePath).files[note]?.revision).toBe(rev);
    mode = 'conflict';
    write(note, 'second text\n');
    const second = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T01:00:00Z') });
    expect(second.exitCode).toBe(1);
    expect(second.summaryText).toContain('WARN put failed alpha/note skipped (exit 1, revision_conflict)');
    expect(readManifest(config.statePath).files[note]?.revision).toBe(rev);
    expect(second.summaryText).not.toContain('--force');
  });

  test('an unindexed loader file is moved aside without sync, and a stranger file stays', async () => {
    const home = temp('gbrain-loader-hold-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/note.md');
    write(note, 'hello note\n');
    const target = join(share, 'personalgrok/gbrain/personal');
    const occupant = join(target, 'alpha/note.md');
    write(occupant, 'left by an earlier loader run\n');
    const kept = join(target, 'alpha/user-kept.md');
    write(kept, 'do not touch this sentence\n');
    const config = baseConfig(home, share);
    writeManifest(config.statePath, {
      version: 1,
      files: {
        [note]: {
          sha256: 'stale',
          bot: 'alpha',
          source: 'personal',
          slug: 'alpha/note',
          output: occupant,
          originRelpath: 'personalgrok/alpha/note.md',
          inBrain: false,
        },
      },
    });
    const calls: string[] = [];
    const brain: BrainClient = {
      async ensureSource(source) {
        calls.push(`ensure ${source}`);
        return { ok: true };
      },
      async putPage(source, slug, file) {
        calls.push(`put ${source} ${slug}`);
        const canonical = join(target, `${slug}.md`);
        if (existsSync(canonical)) return { ok: false, pending: false, code: 'source_changed', detail: 'exit 1, source_changed' };
        return { ok: true, pending: false, revision: '00000000-0000-4000-8000-0000000000bb' };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).not.toContain('put failed alpha/note');
    expect(calls.some((call) => call.startsWith('sync'))).toBe(false);
    expect(existsSync(occupant)).toBe(false);
    expect(readFileSync(join(home, 'loader-held/personal/alpha/note.md'), 'utf8')).toBe('left by an earlier loader run\n');
    expect((statSync(join(home, 'loader-held')).mode & 0o777)).toBe(0o700);
    expect(readFileSync(kept, 'utf8')).toBe('do not touch this sentence\n');
    expect(readManifest(config.statePath).files[note]?.inBrain).toBe(true);
    expect(calls.filter((call) => call === 'put personal alpha/note').length).toBe(2);
  });

  test('a symlink occupant and an in-brain neighbor are not moved', async () => {
    const home = temp('gbrain-loader-symlink-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/note.md');
    write(note, 'hello note\n');
    const target = join(share, 'personalgrok/gbrain/personal');
    const outside = join(home, 'outside.md');
    write(outside, 'do not follow this sentence\n');
    const occupant = join(target, 'alpha/note.md');
    mkdirSync(join(target, 'alpha'), { recursive: true });
    symlinkSync(outside, occupant);
    const neighbor = join(share, 'personalgrok/alpha/other.md');
    write(neighbor, 'other\n');
    const neighborOut = join(target, 'alpha/other.md');
    write(neighborOut, 'indexed neighbor\n');
    const config = baseConfig(home, share);
    writeManifest(config.statePath, {
      version: 1,
      files: {
        [note]: {
          sha256: 'stale', bot: 'alpha', source: 'personal', slug: 'alpha/note', output: occupant,
          originRelpath: 'personalgrok/alpha/note.md', inBrain: false,
        },
        [neighbor]: {
          sha256: sha256(readFileSync(neighbor)), bot: 'alpha', source: 'personal', slug: 'alpha/other',
          output: neighborOut, originRelpath: 'personalgrok/alpha/other.md', inBrain: true,
          revision: '00000000-0000-4000-8000-0000000000dd',
        },
      },
    });
    const puts: string[] = [];
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage(_source, slug) {
        puts.push(slug);
        return { ok: true, pending: false, revision: '00000000-0000-4000-8000-0000000000ee' };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(result.exitCode).toBe(1);
    expect(puts).not.toContain('alpha/note');
    expect(result.summaryText).toContain('WARN put failed alpha/note (not a regular file)');
    expect(lstatSync(occupant).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('do not follow this sentence\n');
    expect(readFileSync(neighborOut, 'utf8')).toBe('indexed neighbor\n');
    expect(existsSync(join(home, 'loader-held'))).toBe(false);
  });

  test('a successful put is on disk before the next page, so a crash keeps the revision', async () => {
    const home = temp('gbrain-loader-crash-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const first = join(share, 'personalgrok/alpha/one.md');
    const second = join(share, 'personalgrok/alpha/two.md');
    write(first, 'one\n');
    write(second, 'two\n');
    const config = baseConfig(home, share);
    const rev = '00000000-0000-4000-8000-0000000000ff';
    let puts = 0;
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage() {
        puts++;
        if (puts === 2) throw new Error('simulated crash');
        return { ok: true, pending: false, revision: rev };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    await expect(runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') })).rejects.toThrow('simulated crash');
    const saved = readManifest(config.statePath);
    const stored = Object.values(saved.files).filter((entry) => entry.inBrain);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.revision).toBe(rev);
    const again = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain: {
        async ensureSource() { return { ok: true }; },
        async putPage(_source, _slug, _file, revision) {
          expect(revision).toBeUndefined();
          return { ok: true, pending: false, revision: rev };
        },
        async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
      },
      now: new Date('2026-11-11T01:00:00Z'),
    });
    expect(again.exitCode).toBe(0);
    expect(again.summaryText).toContain('unchanged=1');
    expect(again.summaryText).toContain('written=1');
  });

describe('counts, placeholders, and the lock', () => {
  test('failed puts are excluded, pending puts retry, and a gone bot is orphaned', async () => {
    const home = temp('gbrain-loader-puts-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/alpha/local.md'), 'keep\n');
    const retired = join(share, 'retired.md');
    write(retired, 'old\n');
    const config = baseConfig(home, share);
    writeFileSync(config.statePath, JSON.stringify({
      version: 1,
      files: {
        [retired]: { sha256: 'abc', bot: 'retired', source: 'personal', slug: 'retired/old', output: join(share, 'out.md'), originRelpath: 'retired.md', inBrain: true },
      },
    }));
    let mode: 'fail' | 'pending' | 'ok' = 'fail';
    const puts: string[] = [];
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage(_source, slug) {
        puts.push(`${mode}:${slug}`);
        if (mode === 'fail') return { ok: false, pending: false };
        if (mode === 'pending') return { ok: false, pending: true };
        return { ok: true, pending: false };
      },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const failed = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, serveLockHeld: true });
    expect(failed.exitCode).toBe(1);
    expect(failed.summaryText).toContain('bot-loader: failed');
    expect(failed.summaryText).toContain('source personal pages=0 via=pages written by the loader (manifest)');
    expect(failed.summaryText).toContain('WARN live brain totals are unavailable while serve runs');
    expect(failed.summaryText).toContain('orphaned retired 1');
    expect(puts).toHaveLength(1);

    mode = 'pending';
    const waiting = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, serveLockHeld: true });
    expect(waiting.exitCode).toBe(0);
    expect(waiting.summaryText).toContain('bot-loader: ok');
    expect(waiting.summaryText).toContain('source personal pages=0 via=pages written by the loader (manifest)');
    expect(puts).toHaveLength(2);

    mode = 'ok';
    const done = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, serveLockHeld: false });
    expect(done.exitCode).toBe(0);
    expect(done.summaryText).toContain('source personal pages=1 via=pages written by the loader (manifest)');
    expect(done.summaryText).not.toContain('live brain totals are unavailable');
    expect(puts).toHaveLength(3);
  });

  test('example placeholders and a relative gbrain_bin refuse the run', async () => {
    const home = temp('gbrain-loader-placeholder-');
    const example = loadConfig(join(REPO, 'docs/grok/bot-loader/config.example.json'), home);
    expect(example.placeholder).toContain('bot-a');
    const refused = await runLoader({
      config: example,
      hostname: 'test-host',
      isMounted: () => { throw new Error('should not mount'); },
      brain: fakeBrain().brain,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.summaryText).toBe('');

    const share = join(home, 'share');
    mkdirSync(share, { recursive: true });
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const config = baseConfig(home, share);
    config.gbrainBin = 'gbrain';
    const lines: string[] = [];
    const relative = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain: fakeBrain().brain,
      stderr: (line) => lines.push(line),
    });
    expect(relative.exitCode).toBe(1);
    expect(lines.join('\n')).toContain('gbrain_bin must be an absolute path');
    expect(existsSync(config.statePath)).toBe(false);
  });

  test('the example share root is refused unless share_root_confirmed is true', async () => {
    const home = temp('gbrain-share-');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const writeCfg = (share: string, confirmed: boolean) => {
      const path = join(home, `${confirmed ? 'yes' : 'no'}-${share.replace(/[/~]/g, '_')}.json`);
      writeFileSync(path, JSON.stringify({
        share_root: share,
        ...(confirmed ? { share_root_confirmed: true } : {}),
        state_path: join(home, 'state.json'),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: '/usr/bin/gbrain',
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: join(home, 'personal'),
          ensure_source: false,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: join(home, 'in'), required: false }] }],
        }],
      }));
      return loadConfig(path, home);
    };
    for (const share of ['~/mnt/netfs', join(home, 'mnt/netfs')]) {
      const config = writeCfg(share, false);
      expect(config.placeholder).toContain('share_root is the example');
      const refused = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
      expect(refused.exitCode).toBe(1);
      expect(refused.summaryText).toBe('');
    }
    expect(existsSync(join(home, 'state.json'))).toBe(false);
    write(join(home, 'in/note.md'), 'hello\n');
    const confirmed = writeCfg('~/mnt/netfs', true);
    expect(confirmed.placeholder).toBeNull();
    const confirmedBrain = fakeBrain();
    const allowed = await runLoader({ config: confirmed, hostname: 'test-host', isMounted: () => true, brain: confirmedBrain.brain });
    expect(allowed.exitCode).toBe(0);
    expect(confirmedBrain.puts.find((put) => put.slug === 'alpha/note')!.text).toContain('hello');
    expect(existsSync(join(home, 'personal/alpha/note.md'))).toBe(false);
  });

  test('a symlink to the example share root is refused unless it is confirmed', async () => {
    const home = temp('gbrain-share-link-');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const example = join(home, 'mnt/netfs');
    const other = join(home, 'real-share');
    mkdirSync(example, { recursive: true });
    mkdirSync(other, { recursive: true });
    const toExample = join(home, 'link-example');
    const toOther = join(home, 'link-other');
    symlinkSync(example, toExample);
    symlinkSync(other, toOther);
    write(join(home, 'in/note.md'), 'hello\n');
    const writeCfg = (share: string, confirmed: boolean) => {
      const path = join(home, `cfg-${confirmed ? 'yes' : 'no'}-${share.split('/').pop()}.json`);
      writeFileSync(path, JSON.stringify({
        share_root: share,
        ...(confirmed ? { share_root_confirmed: true } : {}),
        state_path: join(home, `state-${confirmed ? 'yes' : 'no'}-${share.split('/').pop()}.json`),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, `lock-${share.split('/').pop()}.lock`),
        host_env: join(home, 'host.env'),
        gbrain_bin: '/usr/bin/gbrain',
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: join(share, 'personal'),
          ensure_source: false,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: join(home, 'in'), required: false }] }],
        }],
      }));
      return loadConfig(path, home);
    };
    const linked = writeCfg(toExample, false);
    expect(linked.placeholder).toContain('share_root is the example');
    const refused = await runLoader({ config: linked, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
    expect(refused.exitCode).toBe(1);
    expect(existsSync(join(example, 'personal/alpha/note.md'))).toBe(false);

    const confirmed = writeCfg(toExample, true);
    expect(confirmed.placeholder).toBeNull();
    const confirmedBrain = fakeBrain();
    const allowed = await runLoader({ config: confirmed, hostname: 'test-host', isMounted: () => true, brain: confirmedBrain.brain });
    expect(allowed.exitCode).toBe(0);
    expect(confirmedBrain.puts.find((put) => put.slug === 'alpha/note')!.text).toContain('hello');
    expect(existsSync(join(example, 'personal/alpha/note.md'))).toBe(false);

    const different = writeCfg(toOther, false);
    expect(different.placeholder).toBeNull();
    const otherBrain = fakeBrain();
    const elsewhere = await runLoader({ config: different, hostname: 'test-host', isMounted: () => true, brain: otherBrain.brain });
    expect(elsewhere.exitCode).toBe(0);
    expect(otherBrain.puts.find((put) => put.slug === 'alpha/note')!.text).toContain('hello');
    expect(existsSync(join(other, 'personal/alpha/note.md'))).toBe(false);
  });

  test('sources add is recorded and not spawned again', async () => {
    const home = temp('gbrain-loader-add-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    write(join(share, 'personalgrok/ledger/feed.md'), 'numbers\n');
    const config = baseConfig(home, share);
    let adds = 0;
    const brain: BrainClient = {
      async ensureSource() { adds += 1; return { ok: true }; },
      async putPage() { return { ok: true, pending: false }; },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    const first = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
    expect(first.exitCode).toBe(0);
    expect(adds).toBe(1);
    expect(readManifest(config.statePath).sources?.finance?.added).toBe(true);
    const second = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
    expect(second.exitCode).toBe(0);
    expect(adds).toBe(1);
  });

  test('a pending put warns after three attempts and still retries', async () => {
    const home = temp('gbrain-loader-stuck-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/alpha/local.md');
    write(note, 'keep\n');
    const config = baseConfig(home, share);
    let puts = 0;
    const brain: BrainClient = {
      async ensureSource() { return { ok: true }; },
      async putPage() { puts += 1; return { ok: false, pending: true }; },
      async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
    };
    let last = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
      expect(result.exitCode).toBe(0);
      expect(result.summaryText).toContain('bot-loader: ok');
      last = result.summaryText;
      if (attempt < 3) expect(result.summaryText).not.toContain('WARN stuck pending');
    }
    expect(puts).toBe(4);
    expect(last).toContain('WARN stuck pending 1');
    expect(readManifest(config.statePath).files[note]?.pendingAttempts).toBe(4);
  });

  test('a second loader refuses the lock and a dead pid is taken over', async () => {
    const home = temp('gbrain-loader-lock-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    write(join(share, 'personalgrok/alpha/local.md'), 'keep\n');
    const bin = join(home, 'gbrain');
    writeFileSync(bin, '#!/bin/sh\nsleep 1\nexit 0\n');
    chmodSync(bin, 0o755);
    const config = baseConfig(home, share, { gbrain_bin: bin });
    const env = { ...process.env, HOME: home, GBRAIN_BOT_LOADER_TEST: '1' };
    const args = [CLI, '--config', join(home, 'config.json'), '--assume-mounted'];
    const first = spawn(process.execPath, args, { env });
    const started = Date.now();
    while (!existsSync(config.lockPath) && Date.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(config.lockPath)).toBe(true);
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('another run holds the lock');
    const code = await new Promise<number>((resolve) => first.on('exit', (status) => resolve(status ?? 1)));
    expect(code).toBe(0);

    const dead = spawnSync('python3', ['-c', 'import os,sys; sys.stdout.write(str(os.getpid()))'], { encoding: 'utf8' });
    writeFileSync(config.lockPath, `${dead.stdout.trim()}\n`);
    const taken = await runLoader({ config, isMounted: () => true, brain: fakeBrain().brain });
    expect(taken.exitCode).toBe(0);
    expect(taken.summaryText).toContain('bot-loader: ok');
  });
});

describe('cli exit codes', () => {
  test('host mismatch exits 0 and an unmounted share exits non-zero', () => {
    const home = temp('gbrain-loader-cli-');
    const share = join(home, 'not-a-mount');
    mkdirSync(share, { recursive: true });
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=not-this-machine\n');
    const config = baseConfig(home, share);
    const wrong = spawnSync(process.execPath, [CLI, '--config', join(home, 'config.json')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(wrong.status).toBe(0);
    expect(wrong.stderr).toContain('does not match GBRAIN_EXPECTED_HOST');
    expect(wrong.stdout).toContain('skipped: wrong host');
    expect(wrong.stdout).not.toContain('sk-');
    expect(readFileSync(config.summaryPath, 'utf8')).toContain('skipped: wrong host');
    expect(existsSync(config.statePath)).toBe(false);

    writeFileSync(join(home, 'host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const mounted = spawnSync(process.execPath, [CLI, '--config', join(home, 'config.json')], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(mounted.status).not.toBe(0);
    expect(mounted.stderr).toContain('not a mounted filesystem');
    expect(existsSync(config.statePath)).toBe(false);
  });
});

describe('box export helper', () => {
  test('dry run writes nothing and a real run swaps a fresh tree', () => {
    const home = temp('gbrain-box-');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"bot-a"}\n');
    write(join(agent, 'memory/profile.md'), '# profile\n');
    write(join(agent, 'memory/log/day.md'), 'day\n');
    write(join(agent, 'memory/log/nested/skip.md'), 'nope\n');
    write(join(agent, 'attachments/note.txt'), 'hello\n');
    write(join(agent, 'attachments/picture.png'), 'png\n');
    write(join(agent, 'attachments/token.txt'), 'nope\n');
    write(join(agent, 'other.md'), 'nope\n');
    write(join(agent, 'secrets.env'), '-----BEGIN RSA PRIVATE KEY-----\n');
    const source = readFileSync(join(agent, 'profile.json'));
    const mtime = statSync(join(agent, 'profile.json')).mtimeMs;
    utimesSync(join(agent, 'profile.json'), mtime / 1000, mtime / 1000);
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'bot-a': agent, 'fin-bot': join(home, 'missing-agent') } }));
    const out = join(home, 'out');
    const dry = spawnSync('python3', [BOX, cfg, '--dry-run', '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry-run bot bot-a files=3 secrets_skipped=2');
    expect(dry.stdout).not.toContain('BEGIN RSA');
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(join(agent, 'profile.json')).equals(source)).toBe(true);

    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    expect(existsSync(join(out, 'EXPORTED_AT'))).toBe(false);
    expect(existsSync(join(out, 'MANIFEST.json'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, 'bot-a/manifest.json'), 'utf8')) as { account: string; bot_id: string; files: Record<string, { size: number; sha256: string }> };
    expect(manifest.account).toBe('account-a');
    expect(manifest.bot_id).toBe('bot-a');
    expect(readFileSync(join(out, 'bot-a/profile.json'), 'utf8')).toContain('bot-a');
    expect(existsSync(join(out, 'bot-a/memory.md'))).toBe(true);
    expect(existsSync(join(out, 'bot-a/routines.md'))).toBe(true);
    expect(readFileSync(join(out, 'bot-a/memory.md'), 'utf8')).not.toContain('nope');
    expect(existsSync(join(out, 'bot-a/memory/log/nested/skip.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/attachments/picture.png'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/attachments/token.txt'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/secrets.env'))).toBe(false);
    expect(statSync(join(agent, 'profile.json')).mtimeMs).toBe(mtime);
    writeFileSync(join(out, 'stale.txt'), 'gone\n');
    const again = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(again.status).toBe(0);
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/manifest.json'))).toBe(true);
    const def = spawnSync('python3', [BOX, cfg, '--account', 'account-a'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(def.status).toBe(0);
    expect(existsSync(join(home, '.gbrain/box-export/bot-a/manifest.json'))).toBe(true);
    expect(existsSync(join(home, '.gbrain/box-export/EXPORTED_AT'))).toBe(false);
  });
});

describe('install and verify scripts', () => {
  test('install refuses a host mismatch and does not overwrite an existing config', () => {
    const home = temp('gbrain-install-');
    mkdirSync(join(home, '.gbrain/serve'), { recursive: true });
    writeFileSync(join(home, '.gbrain/serve/host.env'), 'GBRAIN_EXPECTED_HOST=not-this-machine\n');
    const wrong = spawnSync('bash', [INSTALL], { encoding: 'utf8', env: { ...process.env, HOME: home, GBRAIN_REPO: REPO } });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('does not match GBRAIN_EXPECTED_HOST');
    expect(existsSync(join(home, '.gbrain/bot-loader/config.json'))).toBe(false);

    writeFileSync(join(home, '.gbrain/serve/host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const created = spawnSync('bash', [INSTALL], { encoding: 'utf8', env: { ...process.env, HOME: home, GBRAIN_REPO: REPO } });
    expect(created.status).not.toBe(0);
    expect(created.stderr).toContain('not a mounted filesystem');
    const cfg = join(home, '.gbrain/bot-loader/config.json');
    expect(readFileSync(cfg, 'utf8')).toContain('bot-a');
    expect(existsSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'))).toBe(false);
    writeFileSync(cfg, '{"share_root":"MARKER"}\n');
    const again = spawnSync('bash', [INSTALL], { encoding: 'utf8', env: { ...process.env, HOME: home, GBRAIN_REPO: REPO } });
    expect(again.status).not.toBe(0);
    expect(readFileSync(cfg, 'utf8')).toContain('MARKER');
  });

  test('verify prints PASS or FAIL and uninstall removes the plist', () => {
    const home = temp('gbrain-verify-');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
    mkdirSync(join(home, '.gbrain/serve'), { recursive: true });
    writeFileSync(join(home, '.gbrain/serve/host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const finance = join(home, 'finance');
    mkdirSync(finance, { recursive: true });
    mkdirSync(join(home, '.gbrain/bot-loader'), { recursive: true });
    writeFileSync(join(home, '.gbrain/bot-loader/config.json'), JSON.stringify({
      share_root: home,
      summary_path: join(home, '.gbrain/bot-loader/last-summary.txt'),
      groups: [{ source: 'finance', target_root: finance }],
    }));
    writeFileSync(join(home, '.gbrain/bot-loader/last-summary.txt'), 'bot-loader: ok\nbot alpha source=personal scanned=1 written=0 unchanged=1 skipped=0 secrets_skipped=0 pages=2\nsource personal pages=2 via=pages written by the loader (manifest)\n');
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
    const result = spawnSync('bash', [VERIFY], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS hostname');
    expect(result.stdout).toContain('PASS launchd');
    expect(result.stdout).toContain('PASS status fresh');
    expect(result.stdout).toContain('PASS finance remotes');
    expect(result.stdout).toContain('PASS stuck pending');
    expect(result.stdout).toContain('source personal pages=2 via=pages written by the loader (manifest)');
    writeFileSync(join(home, '.gbrain/bot-loader/last-summary.txt'), 'bot-loader: skipped: wrong host\nWARN hostname does not match GBRAIN_EXPECTED_HOST\n');
    const stale = spawnSync('bash', [VERIFY], { encoding: 'utf8', env });
    expect(stale.status).not.toBe(0);
    expect(stale.stdout).toContain('FAIL status fresh');
    writeFileSync(join(home, '.gbrain/bot-loader/last-summary.txt'), 'bot-loader: ok\nWARN stuck pending 1\n');
    const stuck = spawnSync('bash', [VERIFY], { encoding: 'utf8', env });
    expect(stuck.status).not.toBe(0);
    expect(stuck.stdout).toContain('FAIL stuck pending');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'), '<plist></plist>\n');
    const removed = spawnSync('bash', [UNINSTALL], { encoding: 'utf8', env });
    expect(removed.status).toBe(0);
    expect(existsSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'))).toBe(false);
  });

  test('install writes an absolute gbrain_bin and skips the run while placeholders remain', () => {
    const home = temp('gbrain-install-ready-');
    mkdirSync(join(home, 'mnt/netfs'), { recursive: true });
    mkdirSync(join(home, '.gbrain/serve'), { recursive: true });
    mkdirSync(join(home, '.bun/bin'), { recursive: true });
    writeFileSync(join(home, '.gbrain/serve/host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const gbrain = join(bin, 'gbrain');
    writeFileSync(gbrain, '#!/bin/sh\nexit 0\n');
    writeFileSync(join(home, '.bun/bin/bun'), '#!/bin/sh\necho ran-loader >> "$HOME/loader-ran"\nexit 0\n');
    writeFileSync(join(bin, 'plutil'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
    for (const file of [gbrain, join(home, '.bun/bin/bun'), join(bin, 'plutil'), join(bin, 'launchctl')]) chmodSync(file, 0o755);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GBRAIN_REPO: REPO, GBRAIN_INSTALL: INSTALL };
    const run = () => spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'bash', '-c', 'mount -t tmpfs tmpfs "$HOME/mnt/netfs" && exec bash "$GBRAIN_INSTALL"'], { encoding: 'utf8', env });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`edit ${join(home, '.gbrain/bot-loader/config.json')}, then rerun this block`);
    expect(existsSync(join(home, 'loader-ran'))).toBe(false);
    const cfg = readFileSync(join(home, '.gbrain/bot-loader/config.json'), 'utf8');
    expect(cfg).toContain('bot-a');
    expect(cfg).toContain(`"gbrain_bin": "${gbrain}"`);
    const plist = readFileSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'), 'utf8');
    expect(plist).toContain(`<string>${join(home, '.bun/bin')}:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
    expect(plist).toContain(`<string>${REPO}</string>`);
    expect(plist).not.toContain('__');
    const again = run();
    expect(again.status).toBe(0);
    expect(readFileSync(join(home, '.gbrain/bot-loader/config.json'), 'utf8')).toContain('bot-a');
  });

  test('install skips a symlink to the example share root before starting the loader', () => {
    const home = temp('gbrain-install-link-');
    const example = join(home, 'mnt/netfs');
    const link = join(home, 'share-link');
    mkdirSync(example, { recursive: true });
    symlinkSync(example, link);
    mkdirSync(join(home, '.gbrain/serve'), { recursive: true });
    mkdirSync(join(home, '.gbrain/bot-loader'), { recursive: true });
    mkdirSync(join(home, '.bun/bin'), { recursive: true });
    writeFileSync(join(home, '.gbrain/serve/host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const cfg = join(home, '.gbrain/bot-loader/config.json');
    writeFileSync(cfg, JSON.stringify({
      share_root: link,
      groups: [{ id: 'personal', source: 'personal', target_root: join(link, 'personal'), bots: [{ id: 'test-bot-one', inputs: [] }] }],
    }));
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const gbrain = join(bin, 'gbrain');
    writeFileSync(gbrain, '#!/bin/sh\nexit 0\n');
    writeFileSync(join(home, '.bun/bin/bun'), '#!/bin/sh\necho ran-loader >> "$HOME/loader-ran"\nexit 0\n');
    writeFileSync(join(bin, 'plutil'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
    for (const file of [gbrain, join(home, '.bun/bin/bun'), join(bin, 'plutil'), join(bin, 'launchctl')]) chmodSync(file, 0o755);
    const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GBRAIN_REPO: REPO, GBRAIN_INSTALL: INSTALL };
    const result = spawnSync('unshare', ['--user', '--map-root-user', '--mount', 'bash', '-c', 'mount -t tmpfs tmpfs "$HOME/mnt/netfs" && exec bash "$GBRAIN_INSTALL"'], { encoding: 'utf8', env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`edit ${cfg}, then rerun this block`);
    expect(existsSync(join(home, 'loader-ran'))).toBe(false);
    expect(readFileSync(cfg, 'utf8')).toContain('test-bot-one');
    expect(readFileSync(cfg, 'utf8')).not.toContain('bot-a');
  });
});

const NOW = new Date('2026-11-12T12:00:00Z');

function stampAt(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeFeed(dir: string, when: string, account: string, source: string, files: Record<string, string>): void {
  const listed: Record<string, string> = {};
  let bytes = 0;
  for (const [rel, text] of Object.entries(files)) {
    write(join(dir, rel), text);
    const buf = Buffer.from(text, 'utf8');
    listed[rel] = sha256(buf);
    bytes += buf.length;
  }
  write(join(dir, 'EXPORTED_AT'), `${when}\n${source} 1\n`);
  write(join(dir, 'MANIFEST.json'), `${JSON.stringify({
    version: 1,
    account,
    source,
    exported_at: when,
    files: listed,
    file_count: Object.keys(files).length,
    byte_count: bytes,
  }, null, 2)}\n`);
}

function personalGroup(share: string): Record<string, unknown> {
  return {
    id: 'personal',
    source: 'personal',
    target_root: join(share, 'personalgrok/gbrain/personal'),
    ensure_source: false,
    forbid_git: false,
    extensions: ['.md', '.txt', '.json', '.yaml', '.yml'],
    bots: [{ id: 'alpha', inputs: [{ path: join(share, 'personalgrok/alpha'), required: false }] }],
  };
}

function hermesGroup(share: string, stamp: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hermes',
    source: 'hermes',
    account: 'hermes',
    fail_closed: true,
    ensure_source: true,
    forbid_git: false,
    stamp_root: stamp,
    target_root: join(share, 'personalgrok/gbrain/hermes'),
    extensions: ['.md', '.txt'],
    bots: [{ id: 'hermes', inputs: [{ path: stamp, required: false, role: 'local-feed' }] }],
    ...extra,
  };
}

function businessGroup(share: string, stamp: string, bots: unknown[]): Record<string, unknown> {
  return {
    id: 'business',
    source: 'business',
    account: 'businessgrok',
    fail_closed: true,
    ensure_source: true,
    forbid_git: false,
    stamp_root: stamp,
    box_export_dir: stamp,
    target_root: join(share, 'personalgrok/gbrain/business'),
    extensions: ['.md', '.txt', '.json', '.yaml', '.yml'],
    bots,
  };
}

function feedConfig(home: string, share: string, groups: unknown[]): LoaderConfig {
  const path = join(home, 'config.json');
  writeFileSync(path, JSON.stringify({
    share_root: share,
    state_path: join(home, 'state.json'),
    summary_path: join(home, 'summary.txt'),
    lock_path: join(home, 'run.lock'),
    host_env: join(home, 'host.env'),
    gbrain_bin: '/usr/bin/gbrain',
    max_bytes: 1024,
    box_export_max_age_hours: 36,
    box_export_dir: join(share, 'personalgrok/gbrain/_box-export'),
    groups,
  }));
  writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
  return loadConfig(path, home);
}

function brainSpy(ensureOk: (source: string) => boolean = () => true): {
  brain: BrainClient;
  puts: { source: string; slug: string; file: string; text: string }[];
  ensured: string[];
} {
  const puts: { source: string; slug: string; file: string; text: string }[] = [];
  const ensured: string[] = [];
  const brain: BrainClient = {
    async ensureSource(source) {
      ensured.push(source);
      return { ok: ensureOk(source) };
    },
    async putPage(source, slug, file) {
      puts.push({ source, slug, file, text: existsSync(file) ? readFileSync(file, 'utf8') : '' });
      return { ok: true, pending: false, revision: '00000000-0000-4000-8000-000000000001' };
    },
    async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
  };
  return { brain, puts, ensured };
}

async function runAt(config: LoaderConfig, brain: BrainClient): Promise<{ exitCode: number; summaryText: string }> {
  return runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: NOW, serveLockHeld: true });
}

const realWriteAtomic = files.writeAtomic;
const realMkdir = fs.mkdirSync;
const realWriteFile = fs.writeFileSync;
const destWrites: string[] = [];
const destMkdirs: string[] = [];
const destFileWrites: string[] = [];

function underPath(root: string, path: string): boolean {
  const base = resolve(root);
  const child = resolve(path);
  return child === base || child.startsWith(base.endsWith(sep) ? base : base + sep);
}

function expectNoDestination(target: string): void {
  const hits = [...destWrites, ...destMkdirs, ...destFileWrites].filter((path) => underPath(target, path));
  expect(hits).toEqual([]);
}

describe('fail-closed feeds', () => {
  let writeSpy: { mockRestore: () => void } | null = null;
  let mkdirSpy: { mockRestore: () => void } | null = null;
  let fileSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    destWrites.length = 0;
    destMkdirs.length = 0;
    destFileWrites.length = 0;
    writeSpy = spyOn(files, 'writeAtomic').mockImplementation((path: string, data: string, mode: number) => {
      destWrites.push(path);
      realWriteAtomic(path, data, mode);
    });
    mkdirSpy = spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, mode?: fs.MakeDirectoryOptions) => {
      destMkdirs.push(String(path));
      return realMkdir(path, mode);
    }) as typeof fs.mkdirSync);
    fileSpy = spyOn(fs, 'writeFileSync').mockImplementation(((path: fs.PathLike, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      destFileWrites.push(String(path));
      realWriteFile(path, data, options);
    }) as typeof fs.writeFileSync);
  });

  afterEach(() => {
    writeSpy?.mockRestore();
    mkdirSpy?.mockRestore();
    fileSpy?.mockRestore();
    writeSpy = null;
    mkdirSpy = null;
    fileSpy = null;
  });

  test('old configs load and fail-closed parse rejects a bad group', () => {
    const home = temp('gbrain-feed-cfg-');
    const share = join(home, 'share');
    const example = loadConfig(join(REPO, 'docs/grok/bot-loader/config.example.json'), home);
    expect(example.exportRoots.map((root) => root.account)).toEqual(['account-a', 'account-b']);
    expect(example.groups.every((group) => group.failClosed === false)).toBe(true);
    expect(example.groups.some((group) => group.stampRoot)).toBe(false);
    const stamp = join(share, 'businessgrok/gbrain/_box-export');
    const hermes = join(home, 'hermes-feed');
    const loaded = feedConfig(home, share, [
      personalGroup(share),
      businessGroup(share, stamp, []),
      hermesGroup(share, hermes),
    ]);
    expect(loaded.groups.find((group) => group.source === 'business')?.bots).toEqual([]);
    expect(loaded.groups.find((group) => group.source === 'hermes')?.stampRoot).toBe(hermes);
    const sameBot = feedConfig(home, share, [
      personalGroup(share),
      businessGroup(share, stamp, [{ id: 'alpha', inputs: [{ path: join(stamp, 'alpha'), required: false, role: 'box-export' }] }]),
    ]);
    expect(sameBot.groups.flatMap((group) => group.bots.map((bot) => bot.id))).toEqual(['alpha', 'alpha']);
    expect(() => feedConfig(home, share, [personalGroup(share), { ...personalGroup(share), id: 'personal-2' }])).toThrow(/duplicate bot/);
    expect(() => feedConfig(home, share, [hermesGroup(share, hermes, { account: undefined, stamp_root: undefined })])).toThrow(/account and stamp_root/);
    expect(() => feedConfig(home, share, [hermesGroup(share, join(share, 'personalgrok/gbrain/_box-export'))])).toThrow(/personal box export/);
    expect(() => feedConfig(home, share, [businessGroup(share, stamp, []), { ...businessGroup(share, join(share, 'other'), []), id: 'business-2', stamp_root: stamp, box_export_dir: join(share, 'other') }])).toThrow();
    const mismatch = {
      ...businessGroup(share, stamp, []),
      box_export_dir: join(share, 'businessgrok/gbrain/other'),
    };
    expect(() => feedConfig(home, share, [mismatch])).toThrow(/box_export_dir must match stamp_root/);
    expect(() => feedConfig(home, share, [businessGroup(share, stamp, [{ id: 'example-bot' }])])).toThrow(/needs inputs/);
    expect(() => feedConfig(home, share, [{
      ...hermesGroup(share, hermes),
      extensions: ['.md', '.csv'],
    }])).toThrow(/cannot list \.csv/);
    expect(() => feedConfig(home, share, [{
      ...hermesGroup(share, hermes),
      forbid_git: true,
    }])).toThrow(/cannot set forbid_git/);
    expect(() => feedConfig(home, share, [{
      ...hermesGroup(share, hermes),
      box_export_dir: hermes,
    }])).toThrow(/must not set box_export_dir/);
    expect(() => feedConfig(home, share, [{
      id: 'money',
      source: 'finance',
      fail_closed: true,
      account: 'hermes',
      stamp_root: hermes,
      target_root: join(share, 'personalgrok/gbrain/finance'),
      extensions: ['.md'],
      bots: [],
    }])).toThrow(/cannot be finance/);
    expect(() => feedConfig(home, share, [businessGroup(share, stamp, [{
      id: 'example-bot',
      inputs: [{ path: join(share, 'personalgrok/gbrain/_box-export/example-bot'), required: false, role: 'box-export' }],
    }])])).toThrow(/outside stamp_root/);
  });

  test('stamps, manifests, holdings, and route skip one group only', async () => {
    const home = temp('gbrain-feed-run-');
    const share = join(home, 'share');
    const hermes = join(home, 'hermes-feed');
    write(join(share, 'personalgrok/alpha/local.md'), 'from personal\n');
    write(join(share, 'personalgrok/gbrain/_box-export/EXPORTED_AT'), `${stampAt(1)}\nalpha 1\n`);
    writeFeed(hermes, stampAt(37), 'hermes', 'hermes', { 'note.md': 'too old\n' });
    const stale = feedConfig(home, share, [personalGroup(share), hermesGroup(share, hermes)]);
    const staleRun = brainSpy();
    const staleResult = await runAt(stale, staleRun.brain);
    expect(staleResult.exitCode).toBe(0);
    expect(staleResult.summaryText).toContain('bot-loader: ok');
    expect(staleResult.summaryText).toContain('SKIP hermes: feed stale');
    expectNoDestination(join(share, 'personalgrok/gbrain/hermes'));
    expect(staleResult.summaryText).not.toContain('WARN box-export stale');
    expect(staleResult.summaryText).not.toContain('SKIP personal');
    expect(staleRun.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(staleRun.puts.some((put) => put.source === 'hermes')).toBe(false);
    expect(staleRun.ensured).toEqual([]);

    write(join(share, 'personalgrok/gbrain/_box-export/EXPORTED_AT'), `${stampAt(37)}\nalpha 1\n`);
    writeFeed(hermes, stampAt(1), 'hermes', 'hermes', { 'note.md': 'fresh hermes\n' });
    const fresh = brainSpy();
    const freshResult = await runAt(stale, fresh.brain);
    expect(freshResult.exitCode).toBe(0);
    expect(freshResult.summaryText).toContain('WARN box-export stale');
    expect(freshResult.summaryText).not.toContain('SKIP hermes');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    const hermesPage = fresh.puts.find((put) => put.slug === 'hermes/note')!.text;
    expect(hermesPage).toContain('origin_relpath: "external/hermes/0/note.md"');
    expect(hermesPage).not.toContain('account:');
    expect(fresh.puts.map((put) => put.source)).toContain('hermes');

    const missingHome = temp('gbrain-feed-missing-');
    const missingShare = join(missingHome, 'share');
    write(join(missingShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    const missing = feedConfig(missingHome, missingShare, [personalGroup(missingShare), hermesGroup(missingShare, join(missingHome, 'absent-feed'))]);
    const missingSpy = brainSpy();
    const missingResult = await runAt(missing, missingSpy.brain);
    expect(missingResult.summaryText).toContain('SKIP hermes: input missing');
    expectNoDestination(join(missingShare, 'personalgrok/gbrain/hermes'));
    expect(missingResult.summaryText).not.toContain('SKIP hermes: feed stale');
    expect(missingSpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(missingShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);

    const unsignedHome = temp('gbrain-feed-unsigned-');
    const unsignedShare = join(unsignedHome, 'share');
    const unsignedStamp = join(unsignedHome, 'hermes-feed');
    write(join(unsignedShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    write(join(unsignedStamp, 'EXPORTED_AT'), `${stampAt(1)}\nhermes 1\n`);
    write(join(unsignedStamp, 'note.md'), 'no manifest\n');
    const unsigned = feedConfig(unsignedHome, unsignedShare, [personalGroup(unsignedShare), hermesGroup(unsignedShare, unsignedStamp)]);
    const unsignedResult = await runAt(unsigned, brainSpy().brain);
    expect(unsignedResult.summaryText).toContain('SKIP hermes: unsigned');
    expectNoDestination(join(unsignedShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(unsignedShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const hashHome = temp('gbrain-feed-hash-');
    const hashShare = join(hashHome, 'share');
    const hashStamp = join(hashHome, 'hermes-feed');
    write(join(hashShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(hashStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'original\n' });
    write(join(hashStamp, 'note.md'), 'tampered\n');
    const hashed = feedConfig(hashHome, hashShare, [personalGroup(hashShare), hermesGroup(hashShare, hashStamp)]);
    const hashResult = await runAt(hashed, brainSpy().brain);
    expect(hashResult.summaryText).toContain('SKIP hermes: hash mismatch');
    expectNoDestination(join(hashShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(hashShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const partialHome = temp('gbrain-feed-partial-');
    const partialShare = join(partialHome, 'share');
    const partialStamp = join(partialHome, '_box-export.in');
    write(join(partialShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(partialStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'partial\n' });
    const partial = feedConfig(partialHome, partialShare, [personalGroup(partialShare), hermesGroup(partialShare, partialStamp)]);
    const partialSpy = brainSpy();
    const partialResult = await runAt(partial, partialSpy.brain);
    expect(partialResult.summaryText).toContain('SKIP hermes: partial copy');
    expectNoDestination(join(partialShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(partialShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(partialSpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(partialShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);

    const holdHome = temp('gbrain-feed-hold-');
    const holdShare = join(holdHome, 'share');
    const holdStamp = join(holdHome, 'hermes-feed');
    writeFeed(holdStamp, stampAt(1), 'hermes', 'hermes', { 'Holdings.md': 'names only\n', 'positions.csv': 'h\n1\n' });
    const held = feedConfig(holdHome, holdShare, [hermesGroup(holdShare, holdStamp)]);
    const heldResult = await runAt(held, brainSpy().brain);
    expect(heldResult.exitCode).toBe(0);
    expect(heldResult.summaryText).toContain('SKIP hermes: finance-data');
    expectNoDestination(join(holdShare, 'personalgrok/gbrain/hermes'));
    expect(heldResult.summaryText).not.toContain('empty after allowlist');
    expect(existsSync(join(holdShare, 'personalgrok/gbrain/hermes/hermes/Holdings.md'))).toBe(false);

    const wordHome = temp('gbrain-feed-word-');
    const wordShare = join(wordHome, 'share');
    const wordStamp = join(wordHome, 'hermes-feed');
    writeFeed(wordStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'portfolio is only a word\n' });
    const worded = feedConfig(wordHome, wordShare, [hermesGroup(wordShare, wordStamp)]);
    const wordSpy = brainSpy();
    const wordResult = await runAt(worded, wordSpy.brain);
    expect(wordResult.exitCode).toBe(0);
    expect(wordResult.summaryText).not.toContain('SKIP hermes');
    expect(existsSync(join(wordShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    const wordPage = wordSpy.puts.find((put) => put.slug === 'hermes/note')!.text;
    expect(wordPage).toContain('portfolio is only a word');
    const again = await runAt(worded, wordSpy.brain);
    expect(again.summaryText).toContain('unchanged=1');
    expect(wordSpy.puts).toHaveLength(1);

    const routeHome = temp('gbrain-feed-route-');
    const routeShare = join(routeHome, 'share');
    const routeStamp = join(routeHome, 'hermes-feed');
    const personalTarget = join(routeShare, 'personalgrok/gbrain/personal');
    mkdirSync(personalTarget, { recursive: true });
    const linked = join(routeShare, 'hermes-link');
    symlinkSync(personalTarget, linked);
    write(join(routeShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(routeStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'should not land\n' });
    const routed = feedConfig(routeHome, routeShare, [
      personalGroup(routeShare),
      hermesGroup(routeShare, routeStamp, { target_root: linked }),
    ]);
    const routeSpy = brainSpy();
    const routeResult = await runAt(routed, routeSpy.brain);
    expect(routeResult.exitCode).toBe(0);
    expect(routeResult.summaryText).toContain('SKIP hermes: route');
    expectNoDestination(linked);
    expect(routeSpy.puts.some((put) => put.source === 'hermes')).toBe(false);
    expect(routeSpy.ensured).toEqual([]);
    expect(routeSpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(personalTarget, 'alpha/local.md'))).toBe(false);
    expect(existsSync(join(personalTarget, 'hermes/note.md'))).toBe(false);
  });

  test('ensure failure and empty bots do not block the other groups', async () => {
    const home = temp('gbrain-feed-ensure-');
    const share = join(home, 'share');
    const business = join(share, 'businessgrok/gbrain/_box-export');
    const hermes = join(home, 'hermes-feed');
    write(join(share, 'personalgrok/alpha/local.md'), 'from personal\n');
    write(join(share, 'personalgrok/alpha/secret.txt'), 'sk-abcdefghijklmnopqrstuvwxyz\n');
    write(join(share, 'personalgrok/gbrain/_box-export/EXPORTED_AT'), `${stampAt(1)}\nalpha 1\n`);
    writeFeed(business, stampAt(1), 'businessgrok', 'business', { 'example-bot/hello.md': 'business note\n' });
    writeFeed(hermes, stampAt(1), 'hermes', 'hermes', { 'note.md': 'hermes note\n' });
    const config = feedConfig(home, share, [
      personalGroup(share),
      businessGroup(share, business, [{ id: 'example-bot', inputs: [{ path: join(business, 'example-bot'), required: false, role: 'box-export' }] }]),
      hermesGroup(share, hermes),
    ]);
    const spy = brainSpy((source) => source !== 'business');
    const result = await runAt(config, spy.brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText.startsWith('bot-loader: ok\n')).toBe(true);
    expect(result.summaryText).toContain('SKIP business: source not created');
    expectNoDestination(join(share, 'personalgrok/gbrain/business'));
    expect(result.summaryText).not.toContain('SKIP hermes');
    expect(result.summaryText).not.toContain('SKIP personal');
    expect(result.summaryText).toContain('secrets_skipped=1');
    expect(spy.ensured).toEqual(['business', 'hermes']);
    expect(spy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/secret.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/business/example-bot/hello.md'))).toBe(false);
    expect(spy.puts.find((put) => put.slug === 'hermes/note')!.text).toContain('hermes note');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(spy.puts.some((put) => put.source === 'business')).toBe(false);
    expect(spy.puts.some((put) => put.source === 'hermes')).toBe(true);

    const emptyHome = temp('gbrain-feed-empty-');
    const emptyShare = join(emptyHome, 'share');
    const emptyStamp = join(emptyShare, 'businessgrok/gbrain/_box-export');
    write(join(emptyShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    const empty = feedConfig(emptyHome, emptyShare, [personalGroup(emptyShare), businessGroup(emptyShare, emptyStamp, [])]);
    const emptySpy = brainSpy();
    const emptyResult = await runAt(empty, emptySpy.brain);
    expect(emptyResult.exitCode).toBe(0);
    expect(emptyResult.summaryText).toContain('SKIP business: no bots named');
    expectNoDestination(join(emptyShare, 'personalgrok/gbrain/business'));
    expect(emptySpy.ensured).toEqual([]);
    expect(emptySpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(emptyShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
  });

  test('hermes allowlist skips a denied manifest path and ignores extras', async () => {
    const home = temp('gbrain-feed-allow-');
    const share = join(home, 'share');
    const stamp = join(home, 'hermes-feed');
    writeFeed(stamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'keep\n', 'picture.png': 'png\n' });
    const mixed = feedConfig(home, share, [hermesGroup(share, stamp)]);
    const mixedResult = await runAt(mixed, brainSpy().brain);
    expect(mixedResult.summaryText).toContain('SKIP hermes: denied path in manifest');
    expectNoDestination(join(share, 'personalgrok/gbrain/hermes'));
    expect(mixedResult.summaryText).not.toContain('empty after allowlist');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const onlyHome = temp('gbrain-feed-only-deny-');
    const onlyShare = join(onlyHome, 'share');
    const onlyStamp = join(onlyHome, 'hermes-feed');
    writeFeed(onlyStamp, stampAt(1), 'hermes', 'hermes', { 'picture.png': 'png\n' });
    const only = feedConfig(onlyHome, onlyShare, [hermesGroup(onlyShare, onlyStamp)]);
    const onlyResult = await runAt(only, brainSpy().brain);
    expect(onlyResult.summaryText).toContain('SKIP hermes: empty after allowlist');
    expectNoDestination(join(onlyShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(onlyShare, 'personalgrok/gbrain/hermes/hermes/picture.md'))).toBe(false);

    const extraHome = temp('gbrain-feed-extra-');
    const extraShare = join(extraHome, 'share');
    const extraStamp = join(extraHome, 'hermes-feed');
    writeFeed(extraStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'keep\n' });
    write(join(extraStamp, 'picture.png'), 'png\n');
    const extra = feedConfig(extraHome, extraShare, [hermesGroup(extraShare, extraStamp)]);
    const extraSpy = brainSpy();
    const extraResult = await runAt(extra, extraSpy.brain);
    expect(extraResult.exitCode).toBe(0);
    expect(extraResult.summaryText).not.toContain('SKIP hermes');
    expect(extraSpy.puts.find((put) => put.slug === 'hermes/note')!.text).toContain('keep');
    expect(existsSync(join(extraShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(existsSync(join(extraShare, 'personalgrok/gbrain/hermes/hermes/picture.md'))).toBe(false);
  });

  test('wrong source and an oversized file skip the group before any write', async () => {
    const home = temp('gbrain-feed-wrong-');
    const share = join(home, 'share');
    const stamp = join(home, 'hermes-feed');
    write(join(share, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(stamp, stampAt(1), 'hermes', 'personal', { 'note.md': 'wrong tree\n' });
    const wrong = feedConfig(home, share, [personalGroup(share), hermesGroup(share, stamp)]);
    const wrongSpy = brainSpy();
    const wrongResult = await runAt(wrong, wrongSpy.brain);
    expect(wrongResult.exitCode).toBe(0);
    expect(wrongResult.summaryText).toContain('SKIP hermes: wrong source');
    expectNoDestination(join(share, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(wrongSpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);

    const bigHome = temp('gbrain-feed-big-');
    const bigShare = join(bigHome, 'share');
    const bigStamp = join(bigHome, 'hermes-feed');
    writeFeed(bigStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': `${'x'.repeat(2000)}\n` });
    const big = feedConfig(bigHome, bigShare, [hermesGroup(bigShare, bigStamp)]);
    const bigResult = await runAt(big, brainSpy().brain);
    expect(bigResult.summaryText).toContain('SKIP hermes: oversized');
    expectNoDestination(join(bigShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(bigShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
  });

  test('a 37h business stamp is box-export stale and a fresh hermes feed still writes', async () => {
    const home = temp('gbrain-feed-biz-stale-');
    const share = join(home, 'share');
    const business = join(share, 'businessgrok/gbrain/_box-export');
    const hermes = join(home, 'hermes-feed');
    write(join(share, 'personalgrok/alpha/local.md'), 'from personal\n');
    write(join(business, 'EXPORTED_AT'), `${stampAt(37)}\nexample-bot 0\n`);
    writeFeed(hermes, stampAt(1), 'hermes', 'hermes', { 'note.md': 'fresh hermes\n' });
    const config = feedConfig(home, share, [
      personalGroup(share),
      businessGroup(share, business, [{
        id: 'example-bot',
        inputs: [{ path: join(business, 'example-bot'), required: false, role: 'box-export' }],
      }]),
      hermesGroup(share, hermes),
    ]);
    const bizSpy = brainSpy();
    const result = await runAt(config, bizSpy.brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('SKIP business: box-export stale');
    expect(result.summaryText).not.toContain('SKIP business: feed stale');
    expect(result.summaryText).not.toContain('SKIP hermes');
    expectNoDestination(join(share, 'personalgrok/gbrain/business'));
    expect(existsSync(join(share, 'personalgrok/gbrain/business/example-bot'))).toBe(false);
    expect(bizSpy.puts.find((put) => put.slug === 'hermes/note')!.text).toContain('fresh hermes');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(bizSpy.puts.find((put) => put.slug === 'alpha/local')!.text).toContain('from personal');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(false);
  });

  test('a Zulu stamp with fractional seconds is parseable and still ages out', async () => {
    const home = temp('gbrain-feed-millis-');
    const share = join(home, 'share');
    const stamp = join(home, 'hermes-feed');
    const freshMillis = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(freshMillis).toMatch(/\.000Z$/);
    writeFeed(stamp, freshMillis, 'hermes', 'hermes', { 'note.md': 'millis fresh\n' });
    const fresh = feedConfig(home, share, [hermesGroup(share, stamp)]);
    const freshSpy = brainSpy();
    const freshResult = await runAt(fresh, freshSpy.brain);
    expect(freshResult.exitCode).toBe(0);
    expect(freshResult.summaryText).not.toContain('SKIP hermes');
    expect(freshSpy.puts.find((put) => put.slug === 'hermes/note')!.text).toContain('millis fresh');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const oldHome = temp('gbrain-feed-millis-old-');
    const oldShare = join(oldHome, 'share');
    const oldStamp = join(oldHome, 'hermes-feed');
    const staleMillis = new Date(NOW.getTime() - 37 * 60 * 60 * 1000).toISOString();
    writeFeed(oldStamp, staleMillis, 'hermes', 'hermes', { 'note.md': 'millis old\n' });
    const old = feedConfig(oldHome, oldShare, [hermesGroup(oldShare, oldStamp)]);
    const oldResult = await runAt(old, brainSpy().brain);
    expect(oldResult.summaryText).toContain('SKIP hermes: feed stale');
    expectNoDestination(join(oldShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(oldShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const badHome = temp('gbrain-feed-not-utc-');
    const badShare = join(badHome, 'share');
    const badStamp = join(badHome, 'hermes-feed');
    writeFeed(badStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'offset\n' });
    write(join(badStamp, 'EXPORTED_AT'), '2026-11-12T11:00:00+00:00\nhermes 1\n');
    const bad = feedConfig(badHome, badShare, [hermesGroup(badShare, badStamp)]);
    const badResult = await runAt(bad, brainSpy().brain);
    expect(badResult.summaryText).toContain('SKIP hermes: feed stale');
    expectNoDestination(join(badShare, 'personalgrok/gbrain/hermes'));
    write(join(badStamp, 'EXPORTED_AT'), 'not-a-timestamp\nhermes 1\n');
    const garbage = await runAt(bad, brainSpy().brain);
    expect(garbage.summaryText).toContain('SKIP hermes: feed stale');
    expectNoDestination(join(badShare, 'personalgrok/gbrain/hermes'));
  });

  test('a secret file skips the whole hermes group', async () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz\n';
    const aloneHome = temp('gbrain-feed-secret-one-');
    const aloneShare = join(aloneHome, 'share');
    const aloneStamp = join(aloneHome, 'hermes-feed');
    writeFeed(aloneStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': secret });
    const alone = feedConfig(aloneHome, aloneShare, [hermesGroup(aloneShare, aloneStamp)]);
    const aloneResult = await runAt(alone, brainSpy().brain);
    expect(aloneResult.exitCode).toBe(0);
    expect(aloneResult.summaryText).toContain('SKIP hermes: secret-bearing');
    expect(aloneResult.summaryText).not.toContain('empty after allowlist');
    expect(aloneResult.summaryText).not.toContain('denied path in manifest');
    expectNoDestination(join(aloneShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(aloneShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const mixedHome = temp('gbrain-feed-secret-mix-');
    const mixedShare = join(mixedHome, 'share');
    const mixedStamp = join(mixedHome, 'hermes-feed');
    writeFeed(mixedStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': secret, 'keep.md': 'clean note\n' });
    const mixed = feedConfig(mixedHome, mixedShare, [hermesGroup(mixedShare, mixedStamp)]);
    const mixedResult = await runAt(mixed, brainSpy().brain);
    expect(mixedResult.exitCode).toBe(0);
    expect(mixedResult.summaryText).toContain('SKIP hermes: secret-bearing');
    expect(mixedResult.summaryText).not.toContain('denied path in manifest');
    expectNoDestination(join(mixedShare, 'personalgrok/gbrain/hermes'));
    expect(existsSync(join(mixedShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(existsSync(join(mixedShare, 'personalgrok/gbrain/hermes/hermes/keep.md'))).toBe(false);
  });

  test('verify accepts a fresh personal status that also skips business', () => {
    const home = temp('gbrain-feed-verify-');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
    mkdirSync(join(home, '.gbrain/serve'), { recursive: true });
    writeFileSync(join(home, '.gbrain/serve/host.env'), `GBRAIN_EXPECTED_HOST=${hostName()}\n`);
    const finance = join(home, 'finance');
    mkdirSync(finance, { recursive: true });
    mkdirSync(join(home, '.gbrain/bot-loader'), { recursive: true });
    writeFileSync(join(home, '.gbrain/bot-loader/config.json'), JSON.stringify({
      share_root: home,
      summary_path: join(home, '.gbrain/bot-loader/last-summary.txt'),
      groups: [{ source: 'finance', target_root: finance }],
    }));
    writeFileSync(join(home, '.gbrain/bot-loader/last-summary.txt'), [
      'bot-loader: ok',
      'bot alpha source=personal scanned=1 written=1 unchanged=0 skipped=0 secrets_skipped=0 pages=1',
      'source personal pages=1 via=pages written by the loader (manifest)',
      'SKIP business: no bots named',
      'SKIP hermes: feed stale',
      '',
    ].join('\n'));
    const result = spawnSync('bash', [VERIFY], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS status fresh');
  });

  test('box export writes a per-bot manifest with the account tag', () => {
    const home = temp('gbrain-feed-box-');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"example-bot"}\n');
    write(join(agent, 'memory/profile.md'), '# profile\n');
    write(join(agent, 'attachments/note.txt'), 'hello\n');
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'example-bot': agent } }));
    const plain = join(home, 'plain');
    const noAccount = spawnSync('python3', [BOX, cfg, '--out', plain], { encoding: 'utf8' });
    expect(noAccount.status).not.toBe(0);
    expect(existsSync(plain)).toBe(false);
    const out = join(home, 'out');
    const dry = spawnSync('python3', [BOX, cfg, '--dry-run', '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(existsSync(out)).toBe(false);
    const sourceFlag = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a', '--source', 'business'], { encoding: 'utf8' });
    expect(sourceFlag.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    const closed = join(home, 'closed');
    const signed = spawnSync('python3', [BOX, cfg, '--out', closed, '--account', 'account-a', '--source', 'business', '--fail-closed'], { encoding: 'utf8' });
    expect(signed.status).toBe(0);
    expect(existsSync(join(closed, 'EXPORTED_AT'))).toBe(true);
    expect(existsSync(join(closed, 'example-bot/manifest.json'))).toBe(false);
    const tree = JSON.parse(readFileSync(join(closed, 'MANIFEST.json'), 'utf8')) as {
      version: number;
      account: string;
      source: string;
      exported_at: string;
      files: Record<string, string>;
      file_count: number;
    };
    expect(tree.version).toBe(1);
    expect(tree.account).toBe('account-a');
    expect(tree.source).toBe('business');
    expect(tree.exported_at.endsWith('Z')).toBe(true);
    expect(typeof tree.files['example-bot/profile.json']).toBe('string');
    expect(tree.file_count).toBe(Object.keys(tree.files).length);
    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    expect(existsSync(join(out, 'MANIFEST.json'))).toBe(false);
    expect(existsSync(join(out, 'EXPORTED_AT'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, 'example-bot/manifest.json'), 'utf8')) as {
      version: number;
      account: string;
      bot_id: string;
      bot_name: string;
      exported_at: string;
      files: Record<string, { size: number; sha256: string }>;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.account).toBe('account-a');
    expect(manifest.bot_id).toBe('example-bot');
    expect(manifest.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const rels = Object.keys(manifest.files).sort();
    expect(rels).toEqual(['memory.md', 'profile.json', 'routines.md']);
    for (const rel of rels) {
      const body = readFileSync(join(out, 'example-bot', rel));
      expect(manifest.files[rel]!.sha256).toBe(sha256(body));
      expect(manifest.files[rel]!.size).toBe(body.length);
    }
    expect(existsSync(join(out, 'example-bot/attachments/note.txt'))).toBe(false);
  });

  test('a fail-closed export is accepted by the fail-closed reader', async () => {
    const home = temp('gbrain-feed-produced-');
    const share = join(home, 'share');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"example-bot"}\n');
    write(join(agent, 'memory/profile.md'), '# profile\n\nA fake fact.\n');
    write(join(agent, 'attachments/note.txt'), 'hello\n');
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'example-bot': agent } }));
    const closed = join(share, 'share-a/_box-export');
    const signed = spawnSync('python3', [BOX, cfg, '--out', closed, '--account', 'acme-biz', '--source', 'acme-biz', '--fail-closed'], { encoding: 'utf8' });
    expect(signed.status).toBe(0);
    expect(existsSync(join(closed, 'EXPORTED_AT'))).toBe(true);
    expect(existsSync(join(closed, 'MANIFEST.json'))).toBe(true);
    const target = join(share, 'share-a/pages');
    const group: GroupConfig = {
      id: 'acme-biz',
      source: 'acme-biz',
      account: 'acme-biz',
      failClosed: true,
      ensureSource: true,
      forbidGit: false,
      stampRoot: closed,
      boxExportDir: closed,
      targetRoot: target,
      extensions: ['.md', '.txt', '.json', '.yaml', '.yml'],
      bots: [{ id: 'example-bot', inputs: [{ path: join(closed, 'example-bot'), required: false, role: 'box-export' }] }],
    };
    const config: LoaderConfig = {
      shareRoot: share,
      statePath: join(home, 'state.json'),
      summaryPath: join(home, 'summary.txt'),
      lockPath: join(home, 'run.lock'),
      hostEnv: join(home, 'host.env'),
      gbrainBin: '/usr/bin/gbrain',
      maxBytes: 1024,
      csvMaxRows: 500,
      boxExportMaxAgeHours: 36,
      boxExportDir: join(share, 'share-a/unused-box'),
      placeholder: null,
      groups: [group],
      exportRoots: [],
    };
    writeFileSync(config.hostEnv, 'GBRAIN_EXPECTED_HOST=test-host\n');
    const checked = checkFailClosed(group, {
      groups: config.groups,
      now: new Date(),
      maxBytes: config.maxBytes,
      maxAgeHours: config.boxExportMaxAgeHours,
    });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.files.map((file) => file.relativePosix).sort()).toEqual(['attachments/note.txt', 'memory/profile.md', 'profile.json']);
    const closedSpy = brainSpy();
    const result = await runAt(config, closedSpy.brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).not.toContain('SKIP acme-biz');
    expect(closedSpy.puts.find((put) => put.slug === 'example-bot/memory/profile')!.text).toContain('A fake fact.');
    expect(existsSync(join(target, 'example-bot/memory/profile.md'))).toBe(false);
  });
});
