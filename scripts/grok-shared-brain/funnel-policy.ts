/**
 * Tailscale Funnel stays off. Nothing in this module runs `tailscale`.
 * The operator turns Funnel on in person with FUNNEL_ENABLE_COMMAND.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const FUNNEL_ENABLE_COMMAND = 'tailscale funnel --bg 8767';
export const GATE_HOST = '127.0.0.1';
export const GATE_PORT = 8767;
export const GBRAIN_SERVE_PORT = 8766;

export function defaultFunnelEnabled(): false {
  return false;
}

/** Documents the command and records that this process did not run it. */
export function requestFunnelEnable(): { enabled: false; ran: false; command: string } {
  return { enabled: false, ran: false, command: FUNNEL_ENABLE_COMMAND };
}

function stripShellComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** Lines that would turn Funnel on. Echoed documentation and `funnel status` are not invocations. */
export function findFunnelEnableInvocations(files: { name: string; text: string }[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = file.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = file.name.endsWith('.sh') ? stripShellComment(lines[i] ?? '') : (lines[i] ?? '');
      if (/^\s*(sudo\s+)?tailscale\s+funnel\b/.test(code) && !/^\s*(sudo\s+)?tailscale\s+funnel\s+status\b/.test(code)) {
        hits.push(`${file.name}:${i + 1}`);
      }
      if (/\b(spawn|execFileSync|execSync|execFile)\s*\(/.test(code) && /funnel/.test(code)) {
        hits.push(`${file.name}:${i + 1}`);
      }
    }
  }
  return hits;
}

export function readScriptTree(dir: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    if (!/\.(sh|ts|md)$/.test(entry)) continue;
    out.push({ name: entry, text: readFileSync(path, 'utf8') });
  }
  return out;
}
