/**
 * Remove a stale .git/index.lock only when no git process is running.
 *
 *   bun scripts/grok-shared-brain/cli-clear-index-lock.ts CHECKOUT
 *
 * Exit 0 when the lock is absent or was removed. Exit 2 when it was kept.
 */
import { clearStaleIndexLock } from './index-lock.ts';

const checkout = process.argv[2];
if (!checkout) {
  process.stderr.write('pass the checkout path\n');
  process.exit(1);
}
const result = clearStaleIndexLock(checkout);
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.cleared || result.reason === 'absent' ? 0 : 2);
