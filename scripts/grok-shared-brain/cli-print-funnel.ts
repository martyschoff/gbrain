/**
 * Print the Funnel command for the operator. Does not run it.
 */
import { requestFunnelEnable } from './funnel-policy.ts';

const result = requestFunnelEnable();
process.stdout.write(`${result.command}\n`);
process.exit(result.ran || result.enabled ? 1 : 0);
