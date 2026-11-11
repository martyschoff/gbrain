/**
 * Clear a stale `.git/index.lock` only when the caller passes `force` and the
 * local checks pass.
 *
 * Default is refusal. A git on another computer that has the same share
 * mounted (Windows against the SMB checkout) is not visible in this process
 * list, so removing the lock without an explicit `force` is refused. With
 * `force`, the lock is removed only when the process list is readable, no
 * local git is running, the lock is a regular file at least ten minutes old,
 * and those facts are checked again immediately before unlink.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const STALE_INDEX_LOCK_MS = 10 * 60 * 1000;

export const REFUSED_WITHOUT_FORCE = 'Refusing to remove .git/index.lock: a git process on another computer that shares this folder is not visible from here. Pass --force to remove it only after the local checks pass (no local git process, a regular lock file, at least 10 minutes old, checked again immediately before removal).';

export interface ProcessSnap {
  pid: number;
  comm: string;
}

export interface ClearResult {
  cleared: boolean;
  reason: string;
}

export function parsePs(text: string): ProcessSnap[] {
  const out: ProcessSnap[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    out.push({ pid: Number(match[1]), comm: match[2] ?? '' });
  }
  return out;
}

export function isGitComm(comm: string): boolean {
  const base = comm.split(/[/\\]/).pop() ?? comm;
  return base === 'git' || base === 'git.exe' || base.startsWith('git-');
}

export function gitIsRunning(processes: ProcessSnap[]): boolean {
  return processes.some(process => isGitComm(process.comm));
}

export function listLocalProcesses(): ProcessSnap[] | null {
  try {
    const text = execFileSync('ps', ['-ax', '-o', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parsePs(text);
  } catch {
    return null;
  }
}

export function clearStaleIndexLock(checkout: string, opts?: {
  force?: boolean;
  now?: number;
  listProcesses?: () => ProcessSnap[] | null;
  staleMs?: number;
}): ClearResult {
  const list = opts?.listProcesses ?? listLocalProcesses;
  const now = opts?.now ?? Date.now();
  const staleMs = opts?.staleMs ?? STALE_INDEX_LOCK_MS;
  const gitDir = join(checkout, '.git');
  const lock = join(gitDir, 'index.lock');
  try { lstatSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleared: false, reason: 'absent' };
    return { cleared: false, reason: 'lock_unreadable' };
  }
  if (!opts?.force) return { cleared: false, reason: 'refused_without_force' };

  const processes = list();
  if (processes === null) return { cleared: false, reason: 'process_table_unreadable' };
  if (gitIsRunning(processes)) return { cleared: false, reason: 'git_running' };

  let gitStat: ReturnType<typeof lstatSync>;
  try { gitStat = lstatSync(gitDir); } catch { return { cleared: false, reason: 'no_git_dir' }; }
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) return { cleared: false, reason: 'git_dir_not_a_real_directory' };

  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleared: false, reason: 'absent' };
    return { cleared: false, reason: 'lock_unreadable' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { cleared: false, reason: 'lock_not_a_regular_file' };
  const age = now - stat.mtimeMs;
  if (age < 0) return { cleared: false, reason: 'lock_dated_in_the_future' };
  if (age < staleMs) return { cleared: false, reason: 'lock_not_stale' };

  const again = list();
  if (again === null) return { cleared: false, reason: 'process_table_unreadable' };
  if (gitIsRunning(again)) return { cleared: false, reason: 'git_running' };
  let after: ReturnType<typeof lstatSync>;
  try { after = lstatSync(lock); } catch { return { cleared: false, reason: 'absent' }; }
  if (after.isSymbolicLink() || !after.isFile() || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) {
    return { cleared: false, reason: 'lock_changed' };
  }
  unlinkSync(lock);
  return { cleared: true, reason: 'cleared' };
}
