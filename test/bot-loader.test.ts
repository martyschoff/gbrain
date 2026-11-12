import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig, assertRoutes } from '../scripts/bot-loader/config.ts';
import { createGbrainClient, manifestCounts, putArgv, addSourceArgv } from '../scripts/bot-loader/gbrain-client.ts';
import { shareIsMounted } from '../scripts/bot-loader/host.ts';
import { readManifest } from '../scripts/bot-loader/manifest.ts';
import { csvToMarkdown, renderPage, sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import { contentHasSecret, isSecretFileName } from '../scripts/bot-loader/secrets.ts';
import secretPatterns from '../scripts/bot-loader/secret-patterns.json';
import { slugFromRelative } from '../scripts/bot-loader/slug.ts';
import { formatSummary } from '../scripts/bot-loader/summary.ts';
import type { BrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import type { LoaderConfig } from '../scripts/bot-loader/config.ts';

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

function fakeBrain(): { brain: BrainClient; puts: { source: string; slug: string; file: string }[] } {
  const puts: { source: string; slug: string; file: string }[] = [];
  const brain: BrainClient = {
    async ensureSource() { return { ok: true }; },
    async putPage(source, slug, file) { puts.push({ source, slug, file }); return { ok: true, pending: false }; },
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
      'gbrain', '--source', 'finance', 'put', 'fin-bot/feeds/prices', '--file', '/tmp/prices.md', '--json',
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
      expect(await failed.putPage('finance', 'ledger/failed', '/tmp/failed.md')).toEqual({ ok: false, pending: false });
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
    const personalPage = join(share, 'personalgrok/gbrain/personal/alpha/Hello World.md');
    const financePage = join(share, 'personalgrok/gbrain/finance/ledger/feeds/prices.md');
    expect(existsSync(personalPage)).toBe(true);
    expect(existsSync(financePage)).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/only.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/finance/ledger/cache.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/automations/plan.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/secret.md'))).toBe(false);
    const notesPage = readFileSync(join(share, 'personalgrok/gbrain/personal/alpha/notes.md'), 'utf8');
    expect(notesPage).toContain('The token in this sentence is a word.');
    expect(notesPage).not.toContain('[redacted]');
    const page = readFileSync(personalPage, 'utf8');
    expect(page).toContain('slug: alpha/hello-world');
    expect(page).toContain(`origin_sha256: "${sha256(readFileSync(note))}"`);
    expect(page).toContain('origin_relpath: "personalgrok/alpha/Hello World.md"');
    expect(page).not.toContain('slug: hijack');
    expect(readFileSync(financePage, 'utf8')).toContain('_Truncated after 1 data rows._');
    expect(puts.map((put) => put.source).sort()).toEqual(['finance', 'personal', 'personal', 'personal']);
    expect(puts.every((put) => put.source !== 'personal' || !put.file.includes(`${join('gbrain', 'finance')}`))).toBe(true);
    expect(puts.filter((put) => put.source === 'finance').every((put) => put.file.startsWith(join(share, 'personalgrok/gbrain/finance')))).toBe(true);
    expect(puts.some((put) => put.source === 'personal' && put.file.includes(`${join('gbrain', 'finance')}`))).toBe(false);
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
    const third = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T02:00:00Z') });
    expect(third.summaryText).toContain('orphaned alpha 1');
    expect(third.summaryText).toContain('bot alpha source=personal scanned=5 written=0 unchanged=1 skipped=2 secrets_skipped=2 pages=1');
    expect(third.summaryText).toContain('source personal pages=2 via=pages written by the loader (manifest)');
    expect(existsSync(personalPage)).toBe(true);
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
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/from-box.md'))).toBe(true);
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
    expect(existsSync(join(clean, 'ledger/feed.md'))).toBe(true);

    expect(spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/finance.git'], { cwd: clean }).status).toBe(0);
    const blocked = fakeBrain();
    const refused = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain: blocked.brain });
    expect(refused.exitCode).toBe(1);
    expect(refused.summaryText).toContain('source finance has a git remote; refusing to write');
    expect(blocked.puts.every((put) => put.source === 'personal')).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);
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
    expect(existsSync(join(personal, 'alpha/local.md'))).toBe(true);
    expect(existsSync(join(finance, 'ledger/feed.md'))).toBe(false);
  });
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
    const allowed = await runLoader({ config: confirmed, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
    expect(allowed.exitCode).toBe(0);
    expect(existsSync(join(home, 'personal/alpha/note.md'))).toBe(true);
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
    const allowed = await runLoader({ config: confirmed, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
    expect(allowed.exitCode).toBe(0);
    expect(existsSync(join(example, 'personal/alpha/note.md'))).toBe(true);

    const different = writeCfg(toOther, false);
    expect(different.placeholder).toBeNull();
    const elsewhere = await runLoader({ config: different, hostname: 'test-host', isMounted: () => true, brain: fakeBrain().brain });
    expect(elsewhere.exitCode).toBe(0);
    expect(existsSync(join(other, 'personal/alpha/note.md'))).toBe(true);
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
    const dry = spawnSync('python3', [BOX, cfg, '--dry-run', '--out', out], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('dry-run bot bot-a files=4 secrets_skipped=1');
    expect(dry.stdout).not.toContain('BEGIN RSA');
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(join(agent, 'profile.json')).equals(source)).toBe(true);

    const wet = spawnSync('python3', [BOX, cfg, '--out', out], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    const stamp = readFileSync(join(out, 'EXPORTED_AT'), 'utf8');
    expect(stamp.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(stamp).toContain('bot-a 4');
    expect(readFileSync(join(out, 'bot-a/profile.json'), 'utf8')).toContain('bot-a');
    expect(existsSync(join(out, 'bot-a/memory/log/nested/skip.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/attachments/picture.png'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/attachments/token.txt'))).toBe(false);
    expect(statSync(join(agent, 'profile.json')).mtimeMs).toBe(mtime);
    writeFileSync(join(out, 'stale.txt'), 'gone\n');
    const again = spawnSync('python3', [BOX, cfg, '--out', out], { encoding: 'utf8' });
    expect(again.status).toBe(0);
    expect(existsSync(join(out, 'stale.txt'))).toBe(false);
    expect(existsSync(join(out, 'EXPORTED_AT'))).toBe(true);
    expect(existsSync(join(out, 'MANIFEST.json'))).toBe(false);
    const def = spawnSync('python3', [BOX, cfg], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    expect(def.status).toBe(0);
    expect(existsSync(join(home, '.gbrain/box-export/EXPORTED_AT'))).toBe(true);
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
  puts: { source: string; slug: string; file: string }[];
  ensured: string[];
} {
  const puts: { source: string; slug: string; file: string }[] = [];
  const ensured: string[] = [];
  const brain: BrainClient = {
    async ensureSource(source) {
      ensured.push(source);
      return { ok: ensureOk(source) };
    },
    async putPage(source, slug, file) {
      puts.push({ source, slug, file });
      return { ok: true, pending: false };
    },
    async counts(sources, bots, manifest) { return manifestCounts(sources, bots, manifest); },
  };
  return { brain, puts, ensured };
}

async function runAt(config: LoaderConfig, brain: BrainClient): Promise<{ exitCode: number; summaryText: string }> {
  return runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: NOW, serveLockHeld: true });
}

describe('fail-closed feeds', () => {
  test('old configs load and fail-closed parse rejects a bad group', () => {
    const home = temp('gbrain-feed-cfg-');
    const share = join(home, 'share');
    const example = loadConfig(join(REPO, 'docs/grok/bot-loader/config.example.json'), home);
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
    expect(staleResult.summaryText).not.toContain('WARN box-export stale');
    expect(staleResult.summaryText).not.toContain('SKIP personal');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);
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
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(true);
    const hermesPage = readFileSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'), 'utf8');
    expect(hermesPage).toContain('origin_relpath: "external/hermes/0/note.md"');
    expect(hermesPage).not.toContain('account:');
    expect(fresh.puts.map((put) => put.source)).toContain('hermes');

    const missingHome = temp('gbrain-feed-missing-');
    const missingShare = join(missingHome, 'share');
    write(join(missingShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    const missing = feedConfig(missingHome, missingShare, [personalGroup(missingShare), hermesGroup(missingShare, join(missingHome, 'absent-feed'))]);
    const missingResult = await runAt(missing, brainSpy().brain);
    expect(missingResult.summaryText).toContain('SKIP hermes: input missing');
    expect(missingResult.summaryText).not.toContain('SKIP hermes: feed stale');
    expect(existsSync(join(missingShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);

    const unsignedHome = temp('gbrain-feed-unsigned-');
    const unsignedShare = join(unsignedHome, 'share');
    const unsignedStamp = join(unsignedHome, 'hermes-feed');
    write(join(unsignedShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    write(join(unsignedStamp, 'EXPORTED_AT'), `${stampAt(1)}\nhermes 1\n`);
    write(join(unsignedStamp, 'note.md'), 'no manifest\n');
    const unsigned = feedConfig(unsignedHome, unsignedShare, [personalGroup(unsignedShare), hermesGroup(unsignedShare, unsignedStamp)]);
    const unsignedResult = await runAt(unsigned, brainSpy().brain);
    expect(unsignedResult.summaryText).toContain('SKIP hermes: unsigned');
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
    expect(existsSync(join(hashShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const partialHome = temp('gbrain-feed-partial-');
    const partialShare = join(partialHome, 'share');
    const partialStamp = join(partialHome, '_box-export.in');
    write(join(partialShare, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(partialStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'partial\n' });
    const partial = feedConfig(partialHome, partialShare, [personalGroup(partialShare), hermesGroup(partialShare, partialStamp)]);
    const partialResult = await runAt(partial, brainSpy().brain);
    expect(partialResult.summaryText).toContain('SKIP hermes: partial copy');
    expect(existsSync(join(partialShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(existsSync(join(partialShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);

    const holdHome = temp('gbrain-feed-hold-');
    const holdShare = join(holdHome, 'share');
    const holdStamp = join(holdHome, 'hermes-feed');
    writeFeed(holdStamp, stampAt(1), 'hermes', 'hermes', { 'Holdings.md': 'names only\n', 'positions.csv': 'h\n1\n' });
    const held = feedConfig(holdHome, holdShare, [hermesGroup(holdShare, holdStamp)]);
    const heldResult = await runAt(held, brainSpy().brain);
    expect(heldResult.exitCode).toBe(0);
    expect(heldResult.summaryText).toContain('SKIP hermes: finance-data');
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
    const wordPage = readFileSync(join(wordShare, 'personalgrok/gbrain/hermes/hermes/note.md'), 'utf8');
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
    expect(routeSpy.puts.some((put) => put.source === 'hermes')).toBe(false);
    expect(routeSpy.ensured).toEqual([]);
    expect(existsSync(join(personalTarget, 'alpha/local.md'))).toBe(true);
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
    expect(result.summaryText).not.toContain('SKIP hermes');
    expect(result.summaryText).not.toContain('SKIP personal');
    expect(result.summaryText).toContain('secrets_skipped=1');
    expect(spy.ensured).toEqual(['business', 'hermes']);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/secret.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/business/example-bot/hello.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(true);
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
    expect(emptySpy.ensured).toEqual([]);
    expect(existsSync(join(emptyShare, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);
  });

  test('hermes allowlist skips a denied manifest path and ignores extras', async () => {
    const home = temp('gbrain-feed-allow-');
    const share = join(home, 'share');
    const stamp = join(home, 'hermes-feed');
    writeFeed(stamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'keep\n', 'picture.png': 'png\n' });
    const mixed = feedConfig(home, share, [hermesGroup(share, stamp)]);
    const mixedResult = await runAt(mixed, brainSpy().brain);
    expect(mixedResult.summaryText).toContain('SKIP hermes: denied path in manifest');
    expect(mixedResult.summaryText).not.toContain('empty after allowlist');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);

    const onlyHome = temp('gbrain-feed-only-deny-');
    const onlyShare = join(onlyHome, 'share');
    const onlyStamp = join(onlyHome, 'hermes-feed');
    writeFeed(onlyStamp, stampAt(1), 'hermes', 'hermes', { 'picture.png': 'png\n' });
    const only = feedConfig(onlyHome, onlyShare, [hermesGroup(onlyShare, onlyStamp)]);
    const onlyResult = await runAt(only, brainSpy().brain);
    expect(onlyResult.summaryText).toContain('SKIP hermes: empty after allowlist');
    expect(existsSync(join(onlyShare, 'personalgrok/gbrain/hermes/hermes/picture.md'))).toBe(false);

    const extraHome = temp('gbrain-feed-extra-');
    const extraShare = join(extraHome, 'share');
    const extraStamp = join(extraHome, 'hermes-feed');
    writeFeed(extraStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': 'keep\n' });
    write(join(extraStamp, 'picture.png'), 'png\n');
    const extra = feedConfig(extraHome, extraShare, [hermesGroup(extraShare, extraStamp)]);
    const extraResult = await runAt(extra, brainSpy().brain);
    expect(extraResult.exitCode).toBe(0);
    expect(extraResult.summaryText).not.toContain('SKIP hermes');
    expect(readFileSync(join(extraShare, 'personalgrok/gbrain/hermes/hermes/note.md'), 'utf8')).toContain('keep');
    expect(existsSync(join(extraShare, 'personalgrok/gbrain/hermes/hermes/picture.md'))).toBe(false);
  });

  test('wrong source and an oversized file skip the group before any write', async () => {
    const home = temp('gbrain-feed-wrong-');
    const share = join(home, 'share');
    const stamp = join(home, 'hermes-feed');
    write(join(share, 'personalgrok/alpha/local.md'), 'from personal\n');
    writeFeed(stamp, stampAt(1), 'hermes', 'personal', { 'note.md': 'wrong tree\n' });
    const wrong = feedConfig(home, share, [personalGroup(share), hermesGroup(share, stamp)]);
    const wrongResult = await runAt(wrong, brainSpy().brain);
    expect(wrongResult.exitCode).toBe(0);
    expect(wrongResult.summaryText).toContain('SKIP hermes: wrong source');
    expect(existsSync(join(share, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/alpha/local.md'))).toBe(true);

    const bigHome = temp('gbrain-feed-big-');
    const bigShare = join(bigHome, 'share');
    const bigStamp = join(bigHome, 'hermes-feed');
    writeFeed(bigStamp, stampAt(1), 'hermes', 'hermes', { 'note.md': `${'x'.repeat(2000)}\n` });
    const big = feedConfig(bigHome, bigShare, [hermesGroup(bigShare, bigStamp)]);
    const bigResult = await runAt(big, brainSpy().brain);
    expect(bigResult.summaryText).toContain('SKIP hermes: oversized');
    expect(existsSync(join(bigShare, 'personalgrok/gbrain/hermes/hermes/note.md'))).toBe(false);
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

  test('box export writes a manifest only when account and source are both set', () => {
    const home = temp('gbrain-feed-box-');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"example-bot"}\n');
    write(join(agent, 'memory/profile.md'), '# profile\n');
    write(join(agent, 'attachments/note.txt'), 'hello\n');
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'example-bot': agent } }));
    const plain = join(home, 'plain');
    const noFlags = spawnSync('python3', [BOX, cfg, '--out', plain], { encoding: 'utf8' });
    expect(noFlags.status).toBe(0);
    expect(existsSync(join(plain, 'EXPORTED_AT'))).toBe(true);
    expect(existsSync(join(plain, 'MANIFEST.json'))).toBe(false);
    const out = join(home, 'out');
    const dry = spawnSync('python3', [BOX, cfg, '--dry-run', '--out', out, '--account', 'businessgrok', '--source', 'business'], { encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(existsSync(out)).toBe(false);
    const one = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'businessgrok'], { encoding: 'utf8' });
    expect(one.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'businessgrok', '--source', 'business'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(out, 'MANIFEST.json'), 'utf8')) as {
      version: number;
      account: string;
      source: string;
      exported_at: string;
      files: Record<string, string>;
      file_count: number;
      byte_count: number;
    };
    expect(manifest.version).toBe(1);
    expect(manifest.account).toBe('businessgrok');
    expect(manifest.source).toBe('business');
    expect(manifest.exported_at).toBe(readFileSync(join(out, 'EXPORTED_AT'), 'utf8').split('\n')[0]);
    const rels = Object.keys(manifest.files);
    expect(rels).toEqual(['example-bot/attachments/note.txt', 'example-bot/memory/profile.md', 'example-bot/profile.json']);
    let bytes = 0;
    for (const rel of rels) {
      const body = readFileSync(join(out, rel));
      expect(manifest.files[rel]).toBe(sha256(body));
      bytes += body.length;
    }
    expect(manifest.file_count).toBe(rels.length);
    expect(manifest.byte_count).toBe(bytes);
  });
});
