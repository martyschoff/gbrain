import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readManifest, type Manifest } from './manifest.ts';
import { redactSecrets } from './secrets.ts';

export interface PageCounts {
  sources: Record<string, number>;
  /** Keyed by `source/bot`. */
  bots: Record<string, number>;
  /** Always the loader manifest. Live brain totals are not read. */
  via: 'pages written by the loader (manifest)';
}

export interface PutOutcome {
  /** Exit 0. A failed put and a pending put are both not ok. */
  ok: boolean;
  /** Exit 10: accepted, not committed. Retried next run. Not a failure and not counted. */
  pending: boolean;
  /** Revision from a successful put. Passed back as `--expected-revision`. */
  revision?: string;
  /** Machine error code from a failed command, when the CLI printed one. */
  code?: string;
  /** Short reason: `exit N` plus the error code. No paths and no page text. */
  detail?: string;
}

export interface BrainClient {
  ensureSource(source: string, directory: string): Promise<{ ok: boolean; detail?: string }>;
  putPage(source: string, slug: string, file: string, expectedRevision?: string): Promise<PutOutcome>;
  /** One `gbrain sync --source` for a source this loader configured. Optional so older test doubles still compile. */
  syncSource?(source: string): Promise<{ ok: boolean; code?: string; detail?: string }>;
  /** Read the current page revision. Optional so older test doubles still compile. */
  getRevision?(source: string, slug: string): Promise<{ ok: boolean; revision?: string; code?: string }>;
  counts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): Promise<PageCounts>;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (argv: string[]) => Promise<SpawnResult>;

export function putArgv(bin: string, source: string, slug: string, file: string, expectedRevision?: string): string[] {
  const argv = [bin, 'put', slug, '--source', source, '--file', file];
  if (expectedRevision) argv.push('--expected-revision', expectedRevision);
  argv.push('--json');
  return argv;
}

export function syncArgv(bin: string, source: string): string[] {
  return [bin, 'sync', '--source', source];
}

export function getArgv(bin: string, source: string, slug: string): string[] {
  return [bin, 'get', slug, '--source', source, '--json'];
}

export function addSourceArgv(bin: string, source: string, directory: string): string[] {
  return [bin, 'sources', 'add', source, '--path', directory, '--name', source, '--no-federated', '--force', '--json'];
}

const ALREADY = /already registered|already exists|duplicate key/i;
const PENDING_EXIT = 10;

export function spawnGbrain(argv: string[]): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => resolvePromise({ code: 127, stdout: '', stderr: redactSecrets(error.message) }));
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: redactSecrets(Buffer.concat(err).toString('utf8')),
      });
    });
  });
}

/** Pages this loader has committed. Failed puts, pending puts, missing source files, and gone bots are excluded. */
export function manifestCounts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): PageCounts {
  const sourceCounts: Record<string, number> = {};
  const botCounts: Record<string, number> = {};
  const active = new Set(bots.map((bot) => `${bot.source}/${bot.bot}`));
  for (const source of sources) sourceCounts[source] = 0;
  for (const bot of bots) botCounts[`${bot.source}/${bot.bot}`] = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (!entry.inBrain || entry.pending) continue;
    const key = `${entry.source}/${entry.bot}`;
    if (!active.has(key) || !existsSync(path)) continue;
    if (sourceCounts[entry.source] !== undefined) sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    if (botCounts[key] !== undefined) botCounts[key] = (botCounts[key] ?? 0) + 1;
  }
  return { sources: sourceCounts, bots: botCounts, via: 'pages written by the loader (manifest)' };
}

export function createGbrainClient(bin: string, spawnFn: SpawnFn = spawnGbrain): BrainClient {
  return {
    async ensureSource(source, directory) {
      const result = await spawnFn(addSourceArgv(bin, source, directory));
      if (result.code === 0) return { ok: true };
      if (ALREADY.test(result.stdout) || ALREADY.test(result.stderr)) return { ok: true };
      return { ok: false };
    },
    async putPage(source, slug, file, expectedRevision) {
      const result = await spawnFn(putArgv(bin, source, slug, file, expectedRevision));
      if (result.code === 0) return { ok: true, pending: false, revision: revisionOf(result.stdout) };
      if (result.code === PENDING_EXIT) return { ok: false, pending: true };
      const code = errorCode(result);
      return { ok: false, pending: false, ...(code ? { code } : {}), detail: failureDetail(result, code) };
    },
    async syncSource(source) {
      const result = await spawnFn(syncArgv(bin, source));
      if (result.code === 0) return { ok: true };
      const code = errorCode(result);
      return { ok: false, ...(code ? { code } : {}), detail: failureDetail(result, code) };
    },
    async getRevision(source, slug) {
      const result = await spawnFn(getArgv(bin, source, slug));
      if (result.code === 0) {
        const revision = revisionOf(result.stdout);
        return revision ? { ok: true, revision } : { ok: false };
      }
      const code = errorCode(result);
      return { ok: false, ...(code ? { code } : {}) };
    },
    async counts(sources, bots, manifest) {
      // stats and list call connectEngine. Never spawn them; the manifest is the count.
      return manifestCounts(sources, bots, manifest);
    },
  };
}

export function loadManifestCounts(path: string, sources: string[], bots: { source: string; bot: string }[]): PageCounts {
  return manifestCounts(sources, bots, readManifest(path));
}

const REV = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]*$/;

function jsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function revisionOf(stdout: string): string | undefined {
  const doc = jsonObject(stdout);
  if (!doc) return undefined;
  const outcome = doc.outcome;
  const nested = outcome && typeof outcome === 'object' && !Array.isArray(outcome)
    ? (outcome as Record<string, unknown>).revision
    : undefined;
  for (const value of [doc.revision, nested]) {
    if (typeof value === 'string' && REV.test(value)) return value;
  }
  return undefined;
}

function errorCode(result: SpawnResult): string | undefined {
  for (const text of [result.stdout, result.stderr]) {
    const doc = jsonObject(text);
    if (!doc) continue;
    const raw = typeof doc.code === 'string' ? doc.code : typeof doc.error === 'string' ? doc.error : '';
    if (CODE.test(raw)) return raw;
  }
  return undefined;
}

/** Exit code plus the error code. The CLI message is dropped so a path or a secret cannot land in the summary. */
function failureDetail(result: SpawnResult, code: string | undefined): string {
  return code ? `exit ${result.code}, ${code}` : `exit ${result.code}`;
}
