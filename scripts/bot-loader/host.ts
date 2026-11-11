import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export function readExpectedHost(hostEnvPath: string): { ok: true; expected: string } | { ok: false; reason: 'missing_file' | 'missing_value' } {
  if (!existsSync(hostEnvPath)) return { ok: false, reason: 'missing_file' };
  let expected = '';
  for (const line of readFileSync(hostEnvPath, 'utf8').split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('GBRAIN_EXPECTED_HOST=')) expected = line.slice('GBRAIN_EXPECTED_HOST='.length);
  }
  if ((expected.startsWith('"') && expected.endsWith('"')) || (expected.startsWith("'") && expected.endsWith("'"))) {
    expected = expected.slice(1, -1);
  }
  if (!expected) return { ok: false, reason: 'missing_value' };
  return { ok: true, expected };
}

export function shortHostname(): string {
  try {
    return execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim();
  } catch {
    return execFileSync('hostname', { encoding: 'utf8' }).trim().split('.')[0] ?? '';
  }
}

/** A share root is mounted when it is a directory whose device differs from its parent. */
export function shareIsMounted(shareRoot: string): boolean {
  try {
    const here = statSync(shareRoot);
    if (!here.isDirectory()) return false;
    const parent = statSync(dirname(shareRoot));
    return here.dev !== parent.dev;
  } catch {
    return false;
  }
}

/**
 * True when a live process holds this PGLite directory.
 * Reads the legacy lock metadata and, if present, tries a non-blocking flock
 * on the kernel lock file. It does not open the database.
 */
export function serveLockHeld(dataDir: string): boolean {
  const legacy = join(dataDir, '.gbrain-lock');
  if (existsSync(legacy)) {
    let meta: { pid?: unknown } | null = null;
    try { meta = JSON.parse(readFileSync(join(legacy, 'lock'), 'utf8')) as { pid?: unknown }; } catch { meta = null; }
    if (!meta) return true;
    const pid = typeof meta.pid === 'number' ? meta.pid : 0;
    if (!(pid > 0 && !pidAlive(pid))) return true;
  }
  const kernel = `${dataDir}.gbrain-owner.lock`;
  if (!existsSync(kernel)) return false;
  try {
    execFileSync('flock', ['-n', kernel, '-c', 'true'], { stdio: 'ignore' });
    return false;
  } catch {
    return true;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class LockBusy extends Error {
  constructor() {
    super('bot-loader: another run holds the lock');
    this.name = 'LockBusy';
  }
}

/** Exclusive lock file. A dead pid is cleared once. Returns a release function. */
export function acquireLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      return () => {
        try {
          if (!existsSync(lockPath)) return;
          const current = readFileSync(lockPath, 'utf8').trim();
          if (current === String(process.pid)) unlinkSync(lockPath);
        } catch { /* the next run treats a leftover dead pid as stale */ }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      let pid = 0;
      try { pid = Number(readFileSync(lockPath, 'utf8').trim()); } catch { pid = 0; }
      if (attempt === 0 && existsSync(lockPath) && !pidAlive(pid)) {
        try {
          const info = lstatSync(lockPath);
          if (info.isFile()) unlinkSync(lockPath);
        } catch { /* raced */ }
        continue;
      }
      throw new LockBusy();
    }
  }
  throw new LockBusy();
}
