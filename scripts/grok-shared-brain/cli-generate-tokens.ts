/**
 * Generate the three Funnel client tokens.
 *
 *   bun scripts/grok-shared-brain/cli-generate-tokens.ts [--out ABSOLUTE_PATH] [--force]
 *
 * Default path: ~/.gbrain/serve/funnel-tokens.json (mode 0600).
 * The file stores SHA-256 hashes. Plaintext is printed once on stdout.
 * This command does not enable Tailscale Funnel.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestFunnelEnable } from './funnel-policy.ts';
import { configContainsPlaintext, defaultFunnelTokenPath, generateTokens, repoRootFrom, writeTokenFile } from './tokens.ts';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const out = resolve(arg('--out') ?? defaultFunnelTokenPath());
const force = process.argv.includes('--force');
const repo = repoRootFrom(fileURLToPath(new URL('.', import.meta.url)));
if (existsSync(out) && !force) {
  process.stderr.write(`refusing to overwrite ${out} (pass --force)\n`);
  process.exit(1);
}
const generated = generateTokens();
writeTokenFile(out, generated.config, repo);
const serialized = JSON.stringify(generated.config);
if (configContainsPlaintext(serialized, generated.plaintext)) {
  process.stderr.write('refusing to leave plaintext tokens on disk\n');
  process.exit(1);
}
const funnel = requestFunnelEnable();
process.stdout.write(`${JSON.stringify(generated.plaintext)}\n`);
process.stderr.write(`wrote hashes only to ${out} mode 0600. funnel_enabled=${generated.config.funnel_enabled}. tailscale was not run (ran=${funnel.ran}).\n`);
