/**
 * Listen on 127.0.0.1 for the Funnel gate. Does not run `tailscale`.
 * An unreachable upstream is not fatal: the process still listens, and each
 * proxied request tries the upstream again.
 *
 *   bun scripts/grok-shared-brain/cli-gate.ts --tokens ABSOLUTE_PATH [--upstream http://127.0.0.1:8766] [--port 8767]
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFunnelGate, listenGate } from './gate.ts';
import { guardThisHost } from './host-guard.ts';
import { GATE_PORT, requestFunnelEnable } from './funnel-policy.ts';
import { parseFunnelConfig, repoRootFrom } from './tokens.ts';

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const guard = guardThisHost(process.env.HOME || homedir());
if (!guard.ok) {
  process.stderr.write(`${guard.message}\n`);
  process.exit(guard.status);
}

const tokens = arg('--tokens');
if (!tokens) {
  process.stderr.write('pass --tokens ABSOLUTE_PATH (the hash file, not a token)\n');
  process.exit(1);
}
const config = parseFunnelConfig(JSON.parse(readFileSync(resolve(tokens), 'utf8')));
const funnel = requestFunnelEnable();
const server = createFunnelGate({
  config,
  upstreamBaseUrl: arg('--upstream') ?? 'http://127.0.0.1:8766',
  log: line => process.stderr.write(`${line}\n`),
  repoRoot: repoRootFrom(fileURLToPath(new URL('.', import.meta.url))),
});
const port = Number(arg('--port') ?? GATE_PORT);
const bound = await listenGate(server, port);
process.stderr.write(`funnel gate listening on 127.0.0.1:${bound}. funnel_enabled=${config.funnel_enabled}. tailscale was not run (ran=${funnel.ran}).\n`);
