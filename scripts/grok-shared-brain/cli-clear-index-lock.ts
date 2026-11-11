/**
 * Remove a stale .git/index.lock only with --force, and only when no local
 * git process is running.
 *
 *   bun scripts/grok-shared-brain/cli-clear-index-lock.ts CHECKOUT [--force]
 *
 * Without --force, a lock that exists is left in place and the process exits
 * non-zero. Exit 0 when the lock is absent or was removed. Exit 2 when it was kept.
 */
import { clearStaleIndexLock, REFUSED_WITHOUT_FORCE } from './index-lock.ts';

const args = process.argv.slice(2);
const force = args.includes('--force');
const checkout = args.find(arg => arg !== '--force');
if (!checkout) {
  process.stderr.write('pass the checkout path\n');
  process.exit(1);
}
const result = clearStaleIndexLock(checkout, { force });
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.reason === 'refused_without_force') process.stderr.write(`${REFUSED_WITHOUT_FORCE}\n`);
process.exit(result.cleared || result.reason === 'absent' ? 0 : 2);
