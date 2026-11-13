/**
 * The loader against a real gbrain CLI. No serve, no network, no DATABASE_URL.
 * Fixture names are fake. Set GBRAIN_TEST_BOT_LOADER_UPSTREAM_CLI to a src/cli.ts
 * (for example v0.60.654.0) to run the same cases against that CLI as well.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../scripts/bot-loader/config.ts';
import type { LoaderConfig } from '../scripts/bot-loader/config.ts';
import { createGbrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import type { BrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import { readManifest, writeManifest } from '../scripts/bot-loader/manifest.ts';
import type { Manifest } from '../scripts/bot-loader/manifest.ts';
import { sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';

const REPO = join(import.meta.dir, '..');
const STAMP = '2026-11-12T02:00:00-05:00';
const UPSTREAM = process.env.GBRAIN_TEST_BOT_LOADER_UPSTREAM_CLI ?? '';
const CLIS = [join(REPO, 'src/cli.ts'), ...(UPSTREAM && existsSync(UPSTREAM) ? [UPSTREAM] : [])];

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function cli(bin: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync(bin, args, { encoding: 'utf8' });
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

function git(cwd: string, args: string[]): void {
  const proc = spawnSync('git', ['-c', 'user.name=loader', '-c', 'user.email=loader@example.com', ...args], { cwd, encoding: 'utf8' });
  expect(proc.status, proc.stderr).toBe(0);
}

function installBin(home: string, cliPath: string): string {
  const bin = join(home, 'gbrain-bin');
  writeFileSync(bin, `#!/bin/bash
set -euo pipefail
export HOME='${home}'
export GBRAIN_HOME="$HOME"
unset DATABASE_URL GBRAIN_DATABASE_URL GBRAIN_SOURCE
printf '%s\\n' "$*" >> "$HOME/argv.log"
exec bun --no-env-file run '${cliPath}' "$@"
`);
  chmodSync(bin, 0o755);
  const init = cli(bin, ['init', '--pglite', '--no-embedding']);
  expect(init.code, init.stderr).toBe(0);
  return bin;
}

function hostEnv(home: string): void {
  writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
}

function run(config: LoaderConfig, bin: string, now: string, brain?: BrainClient) {
  return runLoader({
    config,
    hostname: 'test-host',
    isMounted: () => true,
    serveLockHeld: false,
    brain: brain ?? createGbrainClient(bin),
    now: new Date(now),
  });
}

for (const cliPath of CLIS) {
  const label = cliPath.startsWith(REPO) ? 'repo' : 'upstream';

  describe(`bot-loader real CLI (${label})`, () => {
    test('writes pages, reruns, updates by revision, and recovers an unindexed loader file', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-real-'));
      const share = join(home, 'share');
      const personal = join(share, 'personal');
      const other = join(share, 'other');
      const bin = installBin(home, cliPath);
      mkdirSync(personal, { recursive: true });
      git(personal, ['init']);
      write(join(personal, 'README.md'), '# personal\n');
      git(personal, ['add', 'README.md']);
      git(personal, ['commit', '-m', 'initial personal']);
      write(join(other, 'kept.md'), 'untouched other source\n');

      const input = join(share, 'in');
      const note = join(input, 'note.md');
      const fresh = join(input, 'fresh.md');
      write(note, 'hello note\n');
      write(fresh, 'fresh page\n');
      const occupant = join(personal, 'alpha/note.md');
      write(occupant, 'left by an earlier loader run\n');
      const userKept = join(personal, 'alpha/user-kept.md');
      write(userKept, 'do not touch this sentence\n');

      const cfgPath = join(home, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({
        share_root: share,
        state_path: join(home, 'state.json'),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: bin,
        max_bytes: 100000,
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: personal,
          ensure_source: true,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: input, required: true }] }],
        }],
      }));
      hostEnv(home);
      const config = loadConfig(cfgPath, home);
      writeManifest(config.statePath, {
        version: 1,
        files: {
          [note]: {
            sha256: sha256(readFileSync(note)),
            bot: 'alpha',
            source: 'personal',
            slug: 'alpha/note',
            output: occupant,
            originRelpath: 'in/note.md',
            inBrain: false,
          },
        },
      });

      const first = await run(config, bin, '2026-11-11T00:00:00Z');
      expect(first.exitCode, first.summaryText).toBe(0);
      expect(first.summaryText).toContain('written=2');
      expect(first.summaryText).not.toContain('put failed alpha/note');
      const log1 = readFileSync(join(home, 'argv.log'), 'utf8');
      expect(log1).toContain('put alpha/fresh --source personal');
      expect(log1).toContain('put alpha/note --source personal');
      expect(log1.split('\n').some((line) => line.startsWith('sync '))).toBe(false);
      expect(log1.split('\n').filter((line) => line.startsWith('put ')).every((line) => !line.includes('--force'))).toBe(true);
      expect(log1).not.toContain('--source other');
      expect(log1).not.toContain('--working-tree');
      expect(readFileSync(join(home, 'loader-held/personal/alpha/note.md'), 'utf8')).toBe('left by an earlier loader run\n');
      expect(readFileSync(userKept, 'utf8')).toBe('do not touch this sentence\n');
      expect(readFileSync(join(other, 'kept.md'), 'utf8')).toBe('untouched other source\n');
      expect(readFileSync(join(personal, 'alpha/note.md'), 'utf8')).toContain('hello note');
      expect(readFileSync(join(personal, 'alpha/fresh.md'), 'utf8')).toContain('fresh page');
      const gotNote = cli(bin, ['get', 'alpha/note', '--source', 'personal', '--json']);
      const gotFresh = cli(bin, ['get', 'alpha/fresh', '--source', 'personal', '--json']);
      expect(gotNote.code, gotNote.stderr).toBe(0);
      expect(gotFresh.code, gotFresh.stderr).toBe(0);
      const gotOther = cli(bin, ['get', 'kept', '--source', 'other', '--json']);
      expect(gotOther.code).not.toBe(0);
      const gotKept = cli(bin, ['get', 'alpha/user-kept', '--source', 'personal', '--json']);
      expect(gotKept.code).not.toBe(0);

      const stored = readManifest(config.statePath).files[fresh]?.revision;
      expect(stored).toMatch(/^[0-9a-f-]{36}$/i);

      const second = await run(config, bin, '2026-11-11T01:00:00Z');
      expect(second.exitCode, second.summaryText).toBe(0);
      expect(second.summaryText).toContain('written=0');
      expect(second.summaryText).toContain('unchanged=2');

      write(fresh, 'fresh page edited\n');
      const before = readFileSync(join(home, 'argv.log'), 'utf8').length;
      const third = await run(config, bin, '2026-11-11T02:00:00Z');
      expect(third.exitCode, third.summaryText).toBe(0);
      expect(third.summaryText).toContain('written=1');
      const added = readFileSync(join(home, 'argv.log'), 'utf8').slice(before);
      expect(added).toContain(`--expected-revision ${stored}`);
      expect(added).not.toContain('--force');
      expect(readFileSync(join(personal, 'alpha/fresh.md'), 'utf8')).toContain('fresh page edited');
      expect(readFileSync(userKept, 'utf8')).toBe('do not touch this sentence\n');
      expect(readFileSync(join(other, 'kept.md'), 'utf8')).toBe('untouched other source\n');
    }, 180_000);

    test('recovers 24 per-bot occupiers across accounts without importing a stranger or syncing', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-multi-'));
      const stateHome = mkdtempSync(join('/dev/shm', 'gbrain-loader-hold-'));
      const share = join(home, 'share');
      const bin = installBin(home, cliPath);
      const pages = join(share, 'pages');
      const pagesOther = join(share, 'pages-other');
      const drop = join(share, 'drops', '_box-export');
      const dropOther = join(share, 'drops', '_box-export-acct-other');
      const files = ['profile.json', 'memory.md', 'routines.md'];
      const bots = Array.from({ length: 8 }, (_item, index) => `bot-${String(index + 1).padStart(2, '0')}`);
      const manifest: Manifest = { version: 1, files: {} };
      const seeded: { origin: string; output: string; text: string }[] = [];
      for (const bot of bots) {
        const listed: Record<string, { size: number; sha256: string }> = {};
        const bodies: Record<string, string> = {
          'profile.json': `{"id":"${bot}","name":"Bot"}\n`,
          'memory.md': `# Memory\n\nA fake fact for ${bot}.\n`,
          'routines.md': '# Routines\n\n## morning\n\n- schedule: 0 2 * * *\n- prompt: Summarize the day.\n',
        };
        for (const rel of files) {
          const text = bodies[rel]!;
          const origin = join(drop, bot, rel);
          write(origin, text);
          const buf = Buffer.from(text);
          listed[rel] = { size: buf.length, sha256: sha256(buf) };
          const stem = rel.replace(/\.[^.]+$/, '');
          const output = join(pages, 'acct-example', bot, `${stem}.md`);
          write(output, `earlier loader bytes ${bot} ${stem}\n`);
          seeded.push({ origin, output, text: `earlier loader bytes ${bot} ${stem}\n` });
          manifest.files[origin] = {
            sha256: 'stale',
            bot: `acct-example/${bot}`,
            source: 'acct-example',
            slug: `acct-example/${bot}/${stem}`,
            output,
            originRelpath: `drops/_box-export/${bot}/${rel}`,
            inBrain: false,
          };
        }
        write(join(drop, bot, 'manifest.json'), JSON.stringify({
          version: 1, bot_name: 'Bot', bot_id: bot, account: 'acct-example', exported_at: STAMP, files: listed,
        }) + '\n');
      }
      const otherListed: Record<string, { size: number; sha256: string }> = {};
      for (const rel of files) {
        const text = rel === 'profile.json' ? '{"id":"bot-09","name":"Bot"}\n' : `# ${rel}\n\nOther account.\n`;
        const origin = join(dropOther, 'bot-09', rel);
        write(origin, text);
        const buf = Buffer.from(text);
        otherListed[rel] = { size: buf.length, sha256: sha256(buf) };
      }
      write(join(dropOther, 'bot-09', 'manifest.json'), JSON.stringify({
        version: 1, bot_name: 'Bot', bot_id: 'bot-09', account: 'acct-other', exported_at: STAMP, files: otherListed,
      }) + '\n');
      const stranger = join(pages, 'user-kept.md');
      write(stranger, 'plain directory stranger\n');
      const cfgPath = join(home, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({
        share_root: share,
        state_path: join(stateHome, 'state.json'),
        summary_path: join(stateHome, 'summary.txt'),
        lock_path: join(stateHome, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: bin,
        max_bytes: 100000,
        box_export_dir: join(share, 'unused-box'),
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: join(share, 'personal-pages'),
          ensure_source: false,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: join(share, 'empty-alpha'), required: false }] }],
        }],
        export_roots: [
          { account: 'acct-example', path: drop, source: 'acct-example', target_root: pages, ensure_source: true },
          { account: 'acct-other', path: dropOther, source: 'acct-other', target_root: pagesOther, ensure_source: true },
        ],
      }));
      hostEnv(home);
      mkdirSync(join(share, 'empty-alpha'), { recursive: true });
      mkdirSync(join(share, 'unused-box'), { recursive: true });
      const config = loadConfig(cfgPath, home);
      writeManifest(config.statePath, manifest);
      const first = await run(config, bin, '2026-11-12T12:00:00Z');
      expect(first.exitCode, first.summaryText).toBe(0);
      expect(first.summaryText).toContain('source acct-example pages=24');
      expect(first.summaryText).toContain('source acct-other pages=3');
      expect(first.summaryText.match(/written=3/g)?.length).toBe(9);
      const log = readFileSync(join(home, 'argv.log'), 'utf8');
      expect(log.split('\n').some((line) => line.startsWith('sync '))).toBe(false);
      expect(log).not.toContain('--working-tree');
      expect(log.split('\n').filter((line) => line.startsWith('put ')).every((line) => !line.includes('--force'))).toBe(true);
      expect(log).toContain('put acct-example/bot-01/memory --source acct-example');
      expect(log).toContain('put acct-other/bot-09/memory --source acct-other');
      expect((statSync(join(stateHome, 'loader-held')).mode & 0o777)).toBe(0o700);
      expect(statSync(join(stateHome, 'loader-held')).dev).not.toBe(statSync(pages).dev);
      for (const item of seeded) {
        expect(existsSync(item.output)).toBe(true);
        expect(readFileSync(item.output, 'utf8')).not.toContain('earlier loader bytes');
        const held = join(stateHome, 'loader-held', 'acct-example', item.output.slice(pages.length + 1));
        expect(readFileSync(held, 'utf8')).toBe(item.text);
      }
      expect(readFileSync(stranger, 'utf8')).toBe('plain directory stranger\n');
      expect(existsSync(join(stateHome, 'loader-held', 'acct-example', 'user-kept.md'))).toBe(false);
      expect(cli(bin, ['get', 'user-kept', '--source', 'acct-example', '--json']).code).not.toBe(0);
      expect(cli(bin, ['get', 'acct-example/bot-01/memory', '--source', 'acct-example', '--json']).code).toBe(0);
      expect(cli(bin, ['get', 'acct-other/bot-09/routines', '--source', 'acct-other', '--json']).code).toBe(0);
      const memory = readManifest(config.statePath).files[join(drop, 'bot-01', 'memory.md')];
      expect(memory?.inBrain).toBe(true);
      expect(memory?.revision).toMatch(/^[0-9a-f-]{36}$/i);
    }, 300_000);

    test('a git origin is not pulled and a committed stranger is not imported', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-git-'));
      const share = join(home, 'share');
      const bin = installBin(home, cliPath);
      const bare = join(home, 'bare.git');
      git(home, ['init', '--bare', bare]);
      const personal = join(share, 'personal');
      git(home, ['init', personal]);
      git(personal, ['remote', 'add', 'origin', bare]);
      write(join(personal, 'README.md'), '# personal\n');
      write(join(personal, 'committed.md'), 'committed stranger\n');
      git(personal, ['add', 'README.md', 'committed.md']);
      git(personal, ['commit', '-m', 'local']);
      git(personal, ['push', '-u', 'origin', 'HEAD']);
      const head = spawnSync('git', ['-C', personal, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      const other = join(home, 'other-clone');
      git(home, ['clone', bare, other]);
      write(join(other, 'remote-only.md'), 'only on the remote\n');
      git(other, ['add', 'remote-only.md']);
      git(other, ['commit', '-m', 'remote only']);
      git(other, ['push', 'origin', 'HEAD']);

      const input = join(share, 'in');
      const note = join(input, 'note.md');
      write(note, 'hello note\n');
      const occupant = join(personal, 'alpha/note.md');
      write(occupant, 'left by an earlier loader run\n');
      const cfgPath = join(home, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({
        share_root: share,
        state_path: join(home, 'state.json'),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: bin,
        max_bytes: 100000,
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: personal,
          ensure_source: true,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: input, required: true }] }],
        }],
      }));
      hostEnv(home);
      const config = loadConfig(cfgPath, home);
      writeManifest(config.statePath, {
        version: 1,
        files: {
          [note]: {
            sha256: 'stale', bot: 'alpha', source: 'personal', slug: 'alpha/note', output: occupant,
            originRelpath: 'in/note.md', inBrain: false,
          },
        },
      });
      const first = await run(config, bin, '2026-11-11T00:00:00Z');
      expect(first.exitCode, first.summaryText).toBe(0);
      const log = readFileSync(join(home, 'argv.log'), 'utf8');
      expect(log.split('\n').some((line) => line.startsWith('sync '))).toBe(false);
      expect(spawnSync('git', ['-C', personal, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()).toBe(head);
      expect(existsSync(join(personal, 'remote-only.md'))).toBe(false);
      expect(readFileSync(join(personal, 'committed.md'), 'utf8')).toBe('committed stranger\n');
      expect(cli(bin, ['get', 'committed', '--source', 'personal', '--json']).code).not.toBe(0);
      expect(cli(bin, ['get', 'remote-only', '--source', 'personal', '--json']).code).not.toBe(0);
      expect(cli(bin, ['get', 'alpha/note', '--source', 'personal', '--json']).code).toBe(0);
      expect(readFileSync(join(home, 'loader-held/personal/alpha/note.md'), 'utf8')).toBe('left by an earlier loader run\n');
    }, 180_000);

    test('a symlink occupant is refused and the target bytes stay', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-link-'));
      const share = join(home, 'share');
      const bin = installBin(home, cliPath);
      const personal = join(share, 'personal');
      mkdirSync(personal, { recursive: true });
      const added = cli(bin, ['sources', 'add', 'personal', '--path', personal, '--name', 'personal', '--no-federated', '--force', '--json']);
      expect(added.code, added.stderr).toBe(0);
      const outside = join(home, 'outside.md');
      write(outside, 'do not follow this sentence\n');
      const occupant = join(personal, 'alpha/note.md');
      mkdirSync(join(personal, 'alpha'), { recursive: true });
      symlinkSync(outside, occupant);
      const input = join(share, 'in');
      const note = join(input, 'note.md');
      write(note, 'hello note\n');
      const cfgPath = join(home, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({
        share_root: share,
        state_path: join(home, 'state.json'),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: bin,
        max_bytes: 100000,
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: personal,
          ensure_source: true,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: input, required: true }] }],
        }],
      }));
      hostEnv(home);
      const config = loadConfig(cfgPath, home);
      writeManifest(config.statePath, {
        version: 1,
        sources: { personal: { added: true } },
        files: {
          [note]: {
            sha256: 'stale', bot: 'alpha', source: 'personal', slug: 'alpha/note', output: occupant,
            originRelpath: 'in/note.md', inBrain: false,
          },
        },
      });
      const first = await run(config, bin, '2026-11-11T00:00:00Z');
      expect(first.exitCode).toBe(1);
      expect(first.summaryText).toContain('put failed alpha/note (not a regular file)');
      expect(lstatSync(occupant).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('do not follow this sentence\n');
      expect(existsSync(join(home, 'loader-held'))).toBe(false);
      expect(readFileSync(join(home, 'argv.log'), 'utf8').split('\n').some((line) => line.startsWith('sync '))).toBe(false);
    }, 180_000);

    test('a crash after some puts keeps revisions so the rerun does not hit revision_required', async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-crash-'));
      const share = join(home, 'share');
      const bin = installBin(home, cliPath);
      const personal = join(share, 'personal');
      mkdirSync(personal, { recursive: true });
      const input = join(share, 'in');
      const one = join(input, 'one.md');
      const two = join(input, 'two.md');
      const three = join(input, 'three.md');
      write(one, 'one\n');
      write(two, 'two\n');
      write(three, 'three\n');
      const cfgPath = join(home, 'config.json');
      writeFileSync(cfgPath, JSON.stringify({
        share_root: share,
        state_path: join(home, 'state.json'),
        summary_path: join(home, 'summary.txt'),
        lock_path: join(home, 'run.lock'),
        host_env: join(home, 'host.env'),
        gbrain_bin: bin,
        max_bytes: 100000,
        groups: [{
          id: 'personal',
          source: 'personal',
          target_root: personal,
          ensure_source: true,
          forbid_git: false,
          extensions: ['.md'],
          bots: [{ id: 'alpha', inputs: [{ path: input, required: true }] }],
        }],
      }));
      hostEnv(home);
      const config = loadConfig(cfgPath, home);
      const real = createGbrainClient(bin);
      let puts = 0;
      const crashing: BrainClient = {
        ensureSource: (source, directory) => real.ensureSource(source, directory),
        putPage: async (source, slug, file, revision) => {
          puts++;
          if (puts === 3) throw new Error('simulated crash');
          return real.putPage(source, slug, file, revision);
        },
        getRevision: (source, slug) => real.getRevision!(source, slug),
        counts: (sources, bots, manifest) => real.counts(sources, bots, manifest),
      };
      await expect(run(config, bin, '2026-11-11T00:00:00Z', crashing)).rejects.toThrow('simulated crash');
      const saved = Object.values(readManifest(config.statePath).files).filter((entry) => entry.inBrain);
      expect(saved.length).toBe(2);
      expect(saved.every((entry) => /^[0-9a-f-]{36}$/i.test(entry.revision ?? ''))).toBe(true);
      for (const entry of saved) write(join(input, `${entry.slug.split('/').at(-1)}.md`), 'edited after crash\n');
      const before = existsSync(join(home, 'argv.log')) ? readFileSync(join(home, 'argv.log'), 'utf8').length : 0;
      const again = await run(config, bin, '2026-11-11T01:00:00Z');
      expect(again.exitCode, again.summaryText).toBe(0);
      expect(again.summaryText).not.toContain('revision_required');
      const added = readFileSync(join(home, 'argv.log'), 'utf8').slice(before);
      const revisions = added.split('\n').filter((line) => line.includes('--expected-revision '));
      expect(revisions.length).toBe(saved.length);
      expect(added).not.toContain('--force');
    }, 180_000);
  });
}
