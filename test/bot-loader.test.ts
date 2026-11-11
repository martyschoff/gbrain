import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig, assertRoutes } from '../scripts/bot-loader/config.ts';
import { createGbrainClient, manifestCounts, parseSourceCounts, putArgv, addSourceArgv } from '../scripts/bot-loader/gbrain-client.ts';
import { shareIsMounted } from '../scripts/bot-loader/host.ts';
import { readManifest } from '../scripts/bot-loader/manifest.ts';
import { csvToMarkdown, renderPage, sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import { contentHasSecret, isSecretFileName } from '../scripts/bot-loader/secrets.ts';
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
    gbrain_bin: 'gbrain',
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
            id: 'bot-a',
            inputs: [
              { path: join(share, 'personalgrok/bot-a'), required: false },
              { path: join(share, 'personalgrok/gbrain/_box-export/bot-a'), required: false, role: 'box-export' },
            ],
          },
          {
            id: 'bot-b',
            inputs: [{ path: join(share, 'personalgrok/bot-b'), required: false }],
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
            id: 'fin-bot',
            inputs: [
              { path: join(share, 'personalgrok/fin-bot'), required: false },
              { path: join(share, 'personalgrok/fin-bot/feeds'), required: false },
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
    async putPage(source, slug, file) { puts.push({ source, slug, file }); return { ok: true }; },
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
      sources: [{ id: 'personal', pages: 4, via: 'stats' }],
      orphans: [{ bot: 'bot-a', count: 2 }],
      warnings: ['box-export stale'],
    })).toBe([
      'bot-loader: ok',
      'bot bot-a source=personal scanned=1 written=1 unchanged=0 skipped=0 secrets_skipped=0 pages=4',
      'source personal pages=4 via=stats',
      'orphaned bot-a 2',
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
    const client = createGbrainClient('gbrain', async (argv) => {
      recorded.push(argv);
      if (argv[1] === 'stats') return { code: 0, stdout: '{"groups":[{"source_id":"finance","pages":3}]}', stderr: '' };
      if (argv[1] === '--source') return { code: 0, stdout: '{"pages":[{"slug":"fin-bot/feeds/prices"}]}', stderr: '' };
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    return client.ensureSource('finance', '/tmp/finance').then(async () => {
      expect((await client.putPage('finance', 'fin-bot/feeds/prices', '/tmp/prices.md')).ok).toBe(true);
      const counts = await client.counts(['finance'], [{ source: 'finance', bot: 'fin-bot' }], { version: 1, files: {} });
      expect(counts.sources.finance).toBe(3);
      expect(counts.bots['finance/fin-bot']).toBe(1);
      expect(counts.via).toBe('stats');
      expect(recorded.some((argv) => argv.includes('--no-delegate') || argv.includes('push'))).toBe(false);
      expect(parseSourceCounts('noise {"groups":[{"source_id":"personal","pages":2}]}')?.personal).toBe(2);
    });
  });
});

describe('loader run', () => {
  test('allowlist, secrets, finance routing, idempotency, orphans, and summary', async () => {
    const home = temp('gbrain-loader-run-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const note = join(share, 'personalgrok/bot-a/Hello World.md');
    write(note, '---\nslug: hijack\n---\nHello from bot-a\n');
    write(join(share, 'personalgrok/bot-a/skip.png'), 'not-an-image');
    write(join(share, 'personalgrok/bot-a/secret.txt'), 'sk-abcdefghijklmnopqrstuvwxyz\n');
    write(join(share, 'personalgrok/bot-a/.env'), 'X=1\n');
    write(join(share, 'personalgrok/bot-a/automations/plan.md'), 'do not read\n');
    write(join(share, 'personalgrok/bot-a/only.csv'), 'h\n1\n');
    write(join(share, 'personalgrok/bot-b/other.txt'), 'bot-b note\n');
    write(join(share, 'personalgrok/fin-bot/feeds/prices.csv'), 'h1,h2\n1,2\n3,4\n');
    write(join(share, 'personalgrok/fin-bot/cache.db'), 'sqlite-bytes');
    const before = statSync(note).mtimeMs;
    const config = baseConfig(home, share);
    const { brain, puts } = fakeBrain();
    const first = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(first.exitCode).toBe(0);
    expect(first.summaryText).toContain('bot bot-a source=personal');
    expect(first.summaryText).toContain('secrets_skipped=2');
    expect(first.summaryText).toContain('bot fin-bot source=finance');
    expect(first.summaryText).toContain('source finance pages=');
    expect(first.summaryText).toContain('WARN box-export missing');
    expect(first.summaryText).not.toContain('sk-abc');
    expect(first.summaryText).not.toContain('Hello from bot-a');
    const personalPage = join(share, 'personalgrok/gbrain/personal/bot-a/Hello World.md');
    const financePage = join(share, 'personalgrok/gbrain/finance/fin-bot/feeds/prices.md');
    expect(existsSync(personalPage)).toBe(true);
    expect(existsSync(financePage)).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/bot-a/only.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/finance/fin-bot/cache.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/bot-a/automations/plan.md'))).toBe(false);
    const page = readFileSync(personalPage, 'utf8');
    expect(page).toContain('slug: bot-a/hello-world');
    expect(page).toContain(`origin_sha256: "${sha256(readFileSync(note))}"`);
    expect(page).toContain('origin_relpath: "personalgrok/bot-a/Hello World.md"');
    expect(page).not.toContain('slug: hijack');
    expect(readFileSync(financePage, 'utf8')).toContain('_Truncated after 1 data rows._');
    expect(puts.map((put) => put.source).sort()).toEqual(['finance', 'personal', 'personal']);
    expect(puts.every((put) => put.source !== 'personal' || !put.file.includes(`${join('gbrain', 'finance')}`))).toBe(true);
    expect(puts.filter((put) => put.source === 'finance').every((put) => put.file.startsWith(join(share, 'personalgrok/gbrain/finance')))).toBe(true);
    expect(puts.some((put) => put.source === 'personal' && put.file.includes(`${join('gbrain', 'finance')}`))).toBe(false);
    expect(statSync(note).mtimeMs).toBe(before);
    expect(statSync(join(home, 'state.json')).mode & 0o777).toBe(0o600);

    const second = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T01:00:00Z') });
    expect(second.exitCode).toBe(0);
    expect(second.summaryText).toContain('bot bot-a source=personal scanned=5 written=0 unchanged=1 skipped=2 secrets_skipped=2');
    expect(second.summaryText).toContain('bot fin-bot source=finance scanned=2 written=0 unchanged=1 skipped=1 secrets_skipped=0');
    expect(puts).toHaveLength(3);

    const removed = readFileSync(note, 'utf8');
    writeFileSync(note, removed);
    const { unlinkSync } = await import('node:fs');
    unlinkSync(note);
    const third = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T02:00:00Z') });
    expect(third.summaryText).toContain('orphaned bot-a 1');
    expect(existsSync(personalPage)).toBe(true);
    expect(puts).toHaveLength(3);
    expect(readManifest(join(home, 'state.json')).files[note]?.originRelpath).toContain('Hello World.md');
  });

  test('stale box export and missing optional or required inputs warn and still exit 0', async () => {
    const home = temp('gbrain-loader-warn-');
    const share = join(home, 'share');
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
    const stampDir = join(share, 'personalgrok/gbrain/_box-export');
    write(join(stampDir, 'EXPORTED_AT'), '2020-01-01T00:00:00Z\nbot-a 1\n');
    write(join(stampDir, 'bot-a/from-box.md'), 'from box\n');
    write(join(share, 'personalgrok/bot-a/local.md'), 'from share\n');
    const config = baseConfig(home, share);
    config.groups[0]!.bots[0]!.inputs.push({ path: join(share, 'missing-optional'), required: false });
    config.groups[0]!.bots[0]!.inputs.push({ path: join(share, 'missing-required'), required: true });
    const { brain } = fakeBrain();
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain, now: new Date('2026-11-11T00:00:00Z') });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('WARN box-export stale');
    expect(result.summaryText).toContain('WARN optional input missing bot=bot-a');
    expect(result.summaryText).toContain('WARN required input missing bot=bot-a');
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/bot-a/local.md'))).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/bot-a/from-box.md'))).toBe(true);
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
    expect(mismatch.summaryText).toBe('');
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
    write(join(share, 'personalgrok/bot-a/local.md'), 'keep\n');
    write(join(share, 'personalgrok/fin-bot/secret-feed.md'), 'nope\n');
    mkdirSync(join(share, 'personalgrok/gbrain/finance/.git'), { recursive: true });
    const config = baseConfig(home, share);
    const { brain, puts } = fakeBrain();
    const result = await runLoader({ config, hostname: 'test-host', isMounted: () => true, brain });
    expect(result.exitCode).toBe(1);
    expect(result.summaryText).toContain('source finance has git metadata');
    expect(puts.every((put) => put.source === 'personal')).toBe(true);
    expect(existsSync(join(share, 'personalgrok/gbrain/finance/fin-bot/secret-feed.md'))).toBe(false);
    expect(existsSync(join(share, 'personalgrok/gbrain/personal/bot-a/local.md'))).toBe(true);
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
    expect(wrong.stdout).not.toContain('sk-');
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

  test('verify prints launchctl state, the summary, and page counts', () => {
    const home = temp('gbrain-verify-');
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "state = running"\necho "pid = 9"\necho "path = /example/com.gbrain.bot-loader.plist"\n');
    chmodSync(join(bin, 'launchctl'), 0o755);
    mkdirSync(join(home, '.gbrain/bot-loader'), { recursive: true });
    writeFileSync(join(home, '.gbrain/bot-loader/last-summary.txt'), 'bot-loader: ok\nbot bot-a source=personal scanned=1 written=0 unchanged=1 skipped=0 secrets_skipped=0 pages=2\nsource personal pages=2 via=stats\n');
    const result = spawnSync('bash', [VERIFY], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('state = running');
    expect(result.stdout).toContain('bot bot-a source=personal');
    expect(result.stdout).toContain('source personal pages=2 via=stats');
    mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'), '<plist></plist>\n');
    const removed = spawnSync('bash', [UNINSTALL], { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    expect(removed.status).toBe(0);
    expect(existsSync(join(home, 'Library/LaunchAgents/com.gbrain.bot-loader.plist'))).toBe(false);
  });
});
