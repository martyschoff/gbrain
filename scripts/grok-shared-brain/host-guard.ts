/**
 * Refuse to start the funnel gate on the wrong machine.
 *
 * The expected short hostname lives in ~/.gbrain/serve/host.env, outside the
 * repo, as one assignment: GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>. This module
 * does not contain a hostname.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function hostEnvPath(home: string): string {
  return join(home, '.gbrain', 'serve', 'host.env');
}

/** Same assignment parse as setup.sh: skip blanks and comments, then strip one pair of quotes. */
export function parseExpectedHost(text: string): string | null {
  let expected = '';
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('GBRAIN_EXPECTED_HOST=')) expected = line.slice('GBRAIN_EXPECTED_HOST='.length);
  }
  if (
    (expected.startsWith('"') && expected.endsWith('"') && expected.length >= 2)
    || (expected.startsWith("'") && expected.endsWith("'") && expected.length >= 2)
  ) {
    expected = expected.slice(1, -1);
  }
  return expected.length > 0 ? expected : null;
}

export function shortHostname(): string {
  return execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim();
}

export type HostGuard =
  | { ok: true }
  | { ok: false; status: number; message: string };

export function evaluateHostGuard(text: string | null, shortName: string): HostGuard {
  if (text === null) {
    return {
      ok: false,
      status: 1,
      message: 'refusing: missing ~/.gbrain/serve/host.env. Create it with one line: GBRAIN_EXPECTED_HOST=<MAC_HOSTNAME>',
    };
  }
  const expected = parseExpectedHost(text);
  if (!expected) {
    return { ok: false, status: 1, message: 'refusing: GBRAIN_EXPECTED_HOST is missing from ~/.gbrain/serve/host.env' };
  }
  if (shortName !== expected) return { ok: false, status: 1, message: `Wrong machine: ${shortName}` };
  return { ok: true };
}

export function guardThisHost(home: string, shortName = shortHostname()): HostGuard {
  const path = hostEnvPath(home);
  if (!existsSync(path)) return evaluateHostGuard(null, shortName);
  return evaluateHostGuard(readFileSync(path, 'utf8'), shortName);
}
