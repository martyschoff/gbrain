/**
 * The loader against the real CLI in this repo. No serve, no network, no
 * DATABASE_URL. Fixture names are fake (acct-example is not used; alpha is).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../scripts/bot-loader/config.ts';
import { readManifest, writeManifest } from '../scripts/bot-loader/manifest.ts';
import { sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import { createGbrainClient } from '../scripts/bot-loader/gbrain-client.ts';

const REPO = join(import.meta.dir, '..');

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function cli(bin: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = spawnSync(bin, args, { encoding: 'utf8' });
  return { code: proc.status ?? 1, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

describe('bot-loader real CLI', () => {
  test('writes pages, reruns, updates by revision, and recovers an unindexed loader file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-loader-real-'));
    const share = join(home, 'share');
    const personal = join(share, 'personal');
    const other = join(share, 'other');
    const bin = join(home, 'gbrain-bin');
    writeFileSync(bin, `#!/bin/bash
set -euo pipefail
export HOME='${home}'
export GBRAIN_HOME="$HOME"
unset DATABASE_URL GBRAIN_DATABASE_URL GBRAIN_SOURCE
printf '%s\\n' "$*" >> "$HOME/argv.log"
exec bun --no-env-file run '${REPO}/src/cli.ts' "$@"
`);
    chmodSync(bin, 0o755);
    const init = cli(bin, ['init', '--pglite', '--no-embedding']);
    expect(init.code, init.stderr).toBe(0);

    mkdirSync(personal, { recursive: true });
    expect(spawnSync('git', ['init'], { cwd: personal }).status).toBe(0);
    write(join(personal, 'README.md'), '# personal\n');
    expect(spawnSync('git', ['-c', 'user.name=loader', '-c', 'user.email=loader@example.com', 'add', 'README.md'], { cwd: personal }).status).toBe(0);
    expect(spawnSync('git', ['-c', 'user.name=loader', '-c', 'user.email=loader@example.com', 'commit', '-m', 'initial personal'], { cwd: personal }).status).toBe(0);
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
      max_bytes: 1024,
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
    writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
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

    const brain = createGbrainClient(bin);
    const run = (now: string) => runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      serveLockHeld: false,
      brain,
      now: new Date(now),
    });

    const first = await run('2026-11-11T00:00:00Z');
    expect(first.exitCode, first.summaryText).toBe(0);
    expect(first.summaryText).toContain('written=2');
    expect(first.summaryText).not.toContain('put alpha/note failed');
    const log1 = readFileSync(join(home, 'argv.log'), 'utf8');
    expect(log1).toContain('put alpha/fresh --source personal');
    expect(log1).toContain('put alpha/note --source personal');
    expect(log1.split('\n').filter((line) => line.startsWith('sync '))).toEqual(['sync --source personal']);
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

    const stored = readManifest(config.statePath).files[fresh]?.revision;
    expect(stored).toMatch(/^[0-9a-f-]{36}$/i);

    const second = await run('2026-11-11T01:00:00Z');
    expect(second.exitCode, second.summaryText).toBe(0);
    expect(second.summaryText).toContain('written=0');
    expect(second.summaryText).toContain('unchanged=2');

    write(fresh, 'fresh page edited\n');
    const before = readFileSync(join(home, 'argv.log'), 'utf8').length;
    const third = await run('2026-11-11T02:00:00Z');
    expect(third.exitCode, third.summaryText).toBe(0);
    expect(third.summaryText).toContain('written=1');
    const added = readFileSync(join(home, 'argv.log'), 'utf8').slice(before);
    expect(added).toContain(`--expected-revision ${stored}`);
    expect(added).not.toContain('--force');
    expect(readFileSync(join(personal, 'alpha/fresh.md'), 'utf8')).toContain('fresh page edited');
    expect(readFileSync(userKept, 'utf8')).toBe('do not touch this sentence\n');
    expect(readFileSync(join(other, 'kept.md'), 'utf8')).toBe('untouched other source\n');
  }, 180_000);
});
