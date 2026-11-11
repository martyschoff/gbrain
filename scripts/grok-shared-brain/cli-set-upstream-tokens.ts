/**
 * Point each funnel client at its grant JSON. Does not read the grant files
 * and does not print tokens.
 *
 *   bun scripts/grok-shared-brain/cli-set-upstream-tokens.ts --tokens ABSOLUTE_PATH --grants ABSOLUTE_DIR
 *
 * Writes <grants>/{personal,business,hermes}.json into upstream_token_file and
 * leaves the token file mode 0600.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFunnelConfig, repoRootFrom, withUpstreamTokenFiles, writeTokenFile } from './tokens.ts';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const tokens = arg('--tokens');
const grants = arg('--grants');
if (!tokens || !grants) {
  process.stderr.write('pass --tokens ABSOLUTE_PATH and --grants ABSOLUTE_DIR\n');
  process.exit(1);
}

const tokenPath = resolve(tokens);
const grantsDir = resolve(grants);
const repo = repoRootFrom(fileURLToPath(new URL('.', import.meta.url)));
const config = parseFunnelConfig(JSON.parse(readFileSync(tokenPath, 'utf8')));
const next = withUpstreamTokenFiles(config, grantsDir, repo);
writeTokenFile(tokenPath, next, repo);
process.stdout.write('updated upstream_token_file for personal, business, hermes\n');
