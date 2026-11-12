import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../scripts/bot-loader/config.ts';
import { deniedExportContent, deniedExportName } from '../scripts/bot-loader/export-deny.ts';
import type { BrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import { isNewYorkExportTime } from '../scripts/bot-loader/multi-account.ts';
import { sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import type { LoaderConfig } from '../scripts/bot-loader/config.ts';

const REPO = join(import.meta.dir, '..');
const BOX = join(REPO, 'scripts/bot-loader/box-export.py');
const STAMP = '2026-11-12T02:00:00-05:00';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function fakeBrain(): { brain: BrainClient; puts: { source: string; slug: string; file: string }[] } {
  const puts: { source: string; slug: string; file: string }[] = [];
  const brain: BrainClient = {
    async ensureSource() { return { ok: true }; },
    async putPage(source, slug, file) { puts.push({ source, slug, file }); return { ok: true, pending: false }; },
    async counts() { return { sources: {}, bots: {}, via: 'pages written by the loader (manifest)' }; },
  };
  return { brain, puts };
}

function goodFiles(bot: string): Record<string, string> {
  return {
    'profile.json': `{"id":"${bot}","name":"Bot A"}\n`,
    'memory.md': '# Memory\n\n## 2026-11-12\n\nA fake fact.\n',
    'routines.md': '# Routines\n\n## morning\n\n- schedule: 0 2 * * *\n- prompt: Summarize the day.\n',
    'skills/daily.md': '# Daily\n\nSay hello.\n',
    'notes/scratch.md': 'A note.\n',
  };
}

function writeBot(dir: string, account: string, bot: string, files: Record<string, string>, patch?: (manifest: Record<string, unknown>) => void): void {
  const listed: Record<string, { size: number; sha256: string }> = {};
  for (const [rel, text] of Object.entries(files)) {
    write(join(dir, rel), text);
    const buf = Buffer.from(text);
    listed[rel] = { size: buf.length, sha256: sha256(buf) };
  }
  const manifest: Record<string, unknown> = {
    version: 1,
    bot_name: 'Bot A',
    bot_id: bot,
    account,
    exported_at: STAMP,
    files: listed,
  };
  patch?.(manifest);
  write(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
}

function configFor(home: string, share: string, roots: Record<string, unknown>[]): LoaderConfig {
  mkdirSync(join(share, 'empty-alpha'), { recursive: true });
  const path = join(home, 'config.json');
  writeFileSync(path, JSON.stringify({
    share_root: share,
    state_path: join(home, 'state.json'),
    summary_path: join(home, 'summary.txt'),
    lock_path: join(home, 'run.lock'),
    host_env: join(home, 'host.env'),
    gbrain_bin: '/usr/bin/gbrain',
    max_bytes: 100000,
    box_export_dir: join(share, 'unused-box'),
    groups: [{
      id: 'personal',
      source: 'personal',
      target_root: join(share, 'personal-pages'),
      ensure_source: false,
      forbid_git: false,
      bots: [{ id: 'alpha', inputs: [{ path: join(share, 'empty-alpha'), required: false }] }],
    }],
    export_roots: roots,
  }));
  writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
  return loadConfig(path, home);
}

function roots(share: string): Record<string, unknown>[] {
  return [
    { account: 'account-a', path: join(share, 'drops', '_box-export'), source: 'account-a', target_root: join(share, 'pages-a') },
    { account: 'account-b', path: join(share, 'drops', '_box-export-account-b'), source: 'account-b', target_root: join(share, 'pages-b') },
  ];
}

async function run(config: LoaderConfig, brain: BrainClient, exportRecheck?: (botDir: string) => void) {
  return runLoader({
    config,
    hostname: 'test-host',
    isMounted: () => true,
    brain,
    now: new Date('2026-11-12T12:00:00Z'),
    ...(exportRecheck ? { exportRecheck } : {}),
  });
}

describe('multi-account export time', () => {
  test('accepts an America/New_York stamp and rejects a Zulu or wrong offset', () => {
    expect(isNewYorkExportTime(STAMP)).toBe(true);
    expect(isNewYorkExportTime('2026-07-12T02:00:00-04:00')).toBe(true);
    expect(isNewYorkExportTime('2026-11-12T02:00:00Z')).toBe(false);
    expect(isNewYorkExportTime('2026-11-12T02:00:00-04:00')).toBe(false);
    expect(deniedExportName('holdings.csv')).toBe(true);
    expect(deniedExportName('memory.md')).toBe(false);
    expect(deniedExportContent('call ' + '555' + '-' + '010' + '-' + '0199')).toBe(true);
    expect(deniedExportContent('A fake fact.')).toBe(false);
  });
});

describe('multi-account drops', () => {
  test('two accounts ingest a good drop and tag pages with account and bot', async () => {
    const home = temp('gbrain-export-good-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-b', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bot account-a/bot-a source=account-a');
    expect(result.summaryText).toContain('bot account-b/bot-b source=account-b');
    expect(puts.map((put) => put.slug).sort()).toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-b/bot-b/skills/daily');
    const page = readFileSync(join(share, 'pages-a', 'account-a', 'bot-a', 'memory.md'), 'utf8');
    expect(page).toContain('account: "account-a"');
    expect(page).toContain('bot: "bot-a"');
    expect(page).toContain('## 2026-11-12');
    expect(puts.filter((put) => put.source === 'account-a')).toHaveLength(5);
    expect(puts.filter((put) => put.source === 'account-b')).toHaveLength(5);
  });

  test('a sha mismatch is skipped and the rest of the bot is imported', async () => {
    const home = temp('gbrain-export-hash-');
    const share = join(home, 'share');
    const files = goodFiles('bot-a');
    files['memory.md'] = '# Memory\n\n## 2026-11-12\n\nA fake fact.\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', files);
    writeFileSync(join(share, 'drops', '_box-export', 'bot-a', 'memory.md'), '# Memory\n\n## 2026-11-12\n\nA fake tale.\n');
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('hash mismatch memory.md');
    expect(puts.map((put) => put.slug)).not.toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/profile');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/routines');
  });

  test('a bad manifest imports nothing from that folder', async () => {
    const home = temp('gbrain-export-bad-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => { manifest.version = 2; });
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bad manifest');
    expect(puts).toHaveLength(0);
    expect(existsSync(join(share, 'pages-a', 'account-a', 'bot-a', 'profile.md'))).toBe(false);
  });

  test('an account mismatch skips that bot and still imports the other account', async () => {
    const home = temp('gbrain-export-acct-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-a', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('account-b/bot-b: account mismatch');
    expect(puts.every((put) => put.source === 'account-a')).toBe(true);
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug).join(' ')).not.toContain('account-b');
  });

  test('a secret in one bot rejects that folder and does not reject the other account', async () => {
    const home = temp('gbrain-export-secret-');
    const share = join(home, 'share');
    const tainted = goodFiles('bot-a');
    tainted['memory.md'] = '# Memory\n\n-----BEGIN OPENSSH PRIVATE KEY-----\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', tainted);
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-b', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('account-a/bot-a: secret rejected');
    expect(result.summaryText).not.toContain('BEGIN');
    expect(result.summaryText).not.toContain('PRIVATE');
    expect(puts.every((put) => put.source === 'account-b')).toBe(true);
    expect(existsSync(join(share, 'pages-a', 'account-a'))).toBe(false);
  });

  test('a symlink and a path escape are not followed', async () => {
    const home = temp('gbrain-export-link-');
    const share = join(home, 'share');
    const outside = join(home, 'outside.md');
    write(outside, 'outside canary\n');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    symlinkSync(outside, join(dir, 'skills', 'linked.md'));
    const { brain, puts } = fakeBrain();
    const linked = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(linked.exitCode).toBe(0);
    expect(linked.summaryText).toContain('symlink');
    expect(puts).toHaveLength(0);
    expect(linked.summaryText).not.toContain('outside canary');

    const home2 = temp('gbrain-export-escape-');
    const share2 = join(home2, 'share');
    const dir2 = join(share2, 'drops', '_box-export', 'bot-a');
    writeBot(dir2, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => {
      const files = manifest.files as Record<string, { size: number; sha256: string }>;
      files['../outside.md'] = { size: 1, sha256: 'a'.repeat(64) };
    });
    const again = fakeBrain();
    const escaped = await run(configFor(home2, share2, [roots(share2)[0]!]), again.brain);
    expect(escaped.exitCode).toBe(0);
    expect(escaped.summaryText).toContain('path escape');
    expect(again.puts).toHaveLength(0);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside canary\n');
  });

  test('an unlisted file is ignored', async () => {
    const home = temp('gbrain-export-extra-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    write(join(dir, 'extra.md'), 'ignore me please\n');
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('ignored unlisted 1');
    expect(puts).toHaveLength(5);
    const dumped = puts.map((put) => readFileSync(put.file, 'utf8')).join('\n');
    expect(dumped).not.toContain('ignore me please');
  });

  test('a manifest replaced mid-run imports nothing', async () => {
    const home = temp('gbrain-export-race-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain, (botDir) => {
      const path = join(botDir, 'manifest.json');
      const body = JSON.parse(readFileSync(path, 'utf8')) as { exported_at: string };
      body.exported_at = '2026-11-12T03:00:00-05:00';
      writeFileSync(path, JSON.stringify(body) + '\n');
    });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('manifest changed');
    expect(puts).toHaveLength(0);
    expect(existsSync(join(share, 'pages-a', 'account-a'))).toBe(false);
  });

  test('a second run of the same drop writes nothing new', async () => {
    const home = temp('gbrain-export-again-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    const { brain, puts } = fakeBrain();
    const config = configFor(home, share, [roots(share)[0]!]);
    const first = await run(config, brain);
    expect(first.exitCode).toBe(0);
    expect(first.summaryText).toContain('written=5');
    const count = puts.length;
    const second = await run(config, brain);
    expect(second.exitCode).toBe(0);
    expect(second.summaryText).toContain('written=0');
    expect(second.summaryText).toContain('unchanged=5');
    expect(puts).toHaveLength(count);
  });

  test('the exporter drop is ingested, and a bad root name or a fail-closed stamp is refused', async () => {
    const home = temp('gbrain-export-producer-');
    const share = join(home, 'share');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"bot-a","name":"Bot A"}\n');
    write(join(agent, 'memory/log/2026-11-12.md'), 'Remember the fake fact.\n');
    write(join(agent, 'routines.json'), '[{"name":"morning","schedule":"0 2 * * *","prompt":"Summarize the day."}]\n');
    write(join(agent, 'skills/daily.md'), '# Daily\n\nSay hello.\n');
    write(join(agent, 'skills/holdings.md'), 'nope\n');
    write(join(agent, 'notes', 'reach.md'), 'call ' + '555' + '-' + '010' + '-' + '0199' + '\n');
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'bot-a': agent } }));
    const out = join(home, 'share', 'drops', '_box-export');
    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    expect(wet.stdout).not.toContain('555');
    const memory = readFileSync(join(out, 'bot-a/memory.md'), 'utf8');
    expect(memory).toContain('## 2026-11-12');
    expect(memory).toContain('Remember the fake fact.');
    expect(existsSync(join(out, 'bot-a/skills/holdings.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/reach.md'))).toBe(false);
    const routines = readFileSync(join(out, 'bot-a/routines.md'), 'utf8');
    expect(routines).toContain('schedule:');
    expect(routines).toContain('prompt:');
    const manifest = JSON.parse(readFileSync(join(out, 'bot-a/manifest.json'), 'utf8')) as { exported_at: string; account: string };
    expect(manifest.account).toBe('account-a');
    expect(isNewYorkExportTime(manifest.exported_at)).toBe(true);
    const { brain, puts } = fakeBrain();
    const loaded = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(loaded.exitCode).toBe(0);
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/memory');
    expect(readFileSync(puts.find((put) => put.slug === 'account-a/bot-a/memory')!.file, 'utf8')).toContain('Remember the fake fact.');
    expect(puts.map((put) => put.slug).join(' ')).not.toContain('holdings');

    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      share_root: share,
      gbrain_bin: '/usr/bin/gbrain',
      groups: [{ id: 'personal', source: 'personal', target_root: join(share, 'personal-pages'), bots: [] }],
      export_roots: [{ account: 'account-a', path: join(share, 'drops', 'feed'), source: 'account-a', target_root: join(share, 'pages-a') }],
    }));
    expect(() => loadConfig(bad, home)).toThrow(/_box-export/);

    const stamp = join(share, 'feeds', '_box-export');
    mkdirSync(stamp, { recursive: true });
    const closed = join(home, 'closed.json');
    writeFileSync(closed, JSON.stringify({
      share_root: share,
      gbrain_bin: '/usr/bin/gbrain',
      box_export_dir: join(share, 'other', '_box-export'),
      groups: [{
        id: 'hermes',
        source: 'hermes',
        account: 'hermes',
        fail_closed: true,
        stamp_root: stamp,
        target_root: join(share, 'hermes-pages'),
        extensions: ['.md', '.txt'],
        bots: [{ id: 'bot-a', inputs: [{ path: stamp, required: false, role: 'local-feed' }] }],
      }],
      export_roots: [{ account: 'account-a', path: stamp, source: 'account-a', target_root: join(share, 'pages-a') }],
    }));
    expect(() => loadConfig(closed, home)).toThrow(/fail-closed stamp_root/);
  });
});
