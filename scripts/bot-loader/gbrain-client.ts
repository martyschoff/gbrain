import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readManifest, type Manifest } from './manifest.ts';
import { redactSecrets } from './secrets.ts';

export interface PageCounts {
  sources: Record<string, number>;
  /** Keyed by `source/bot`. */
  bots: Record<string, number>;
  via: 'stats' | 'manifest';
}

export interface BrainClient {
  ensureSource(source: string, directory: string): Promise<{ ok: boolean }>;
  putPage(source: string, slug: string, file: string): Promise<{ ok: boolean }>;
  counts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): Promise<PageCounts>;
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (argv: string[]) => Promise<SpawnResult>;

export function putArgv(bin: string, source: string, slug: string, file: string): string[] {
  return [bin, '--source', source, 'put', slug, '--file', file, '--json'];
}

export function addSourceArgv(bin: string, source: string, directory: string): string[] {
  return [bin, 'sources', 'add', source, '--path', directory, '--name', source, '--no-federated', '--force', '--json'];
}

export function statsArgv(bin: string): string[] {
  return [bin, 'stats', '--by', 'source', '--json'];
}

export function listArgv(bin: string, source: string): string[] {
  return [bin, '--source', source, 'list', '--json'];
}

const ALREADY = /already registered|already exists|duplicate key/i;

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

export function parseSourceCounts(stdout: string): Record<string, number> | null {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    const data = JSON.parse(stdout.slice(start)) as { groups?: { source_id?: string; source?: string; pages?: number }[] };
    if (!Array.isArray(data.groups)) return null;
    const counts: Record<string, number> = {};
    for (const group of data.groups) {
      const id = group.source_id ?? group.source;
      if (typeof id !== 'string' || typeof group.pages !== 'number') continue;
      counts[id] = (counts[id] ?? 0) + group.pages;
    }
    return counts;
  } catch {
    return null;
  }
}

export function parseSlugList(stdout: string): string[] | null {
  const startObj = stdout.indexOf('{');
  const startArr = stdout.indexOf('[');
  const start = startObj < 0 ? startArr : startArr < 0 ? startObj : Math.min(startObj, startArr);
  if (start < 0) return null;
  try {
    const data = JSON.parse(stdout.slice(start)) as { pages?: { slug?: string }[]; results?: { slug?: string }[] } | { slug?: string }[];
    const rows = Array.isArray(data) ? data : data.pages ?? data.results;
    if (!Array.isArray(rows)) return null;
    return rows.map((row) => (typeof row.slug === 'string' ? row.slug : '')).filter(Boolean);
  } catch {
    return null;
  }
}

export function manifestCounts(sources: string[], bots: { source: string; bot: string }[], manifest: Manifest): PageCounts {
  const sourceCounts: Record<string, number> = {};
  const botCounts: Record<string, number> = {};
  for (const source of sources) sourceCounts[source] = 0;
  for (const bot of bots) botCounts[`${bot.source}/${bot.bot}`] = 0;
  for (const entry of Object.values(manifest.files)) {
    if (!entry.inBrain || !existsSync(entry.output)) continue;
    if (sourceCounts[entry.source] !== undefined) sourceCounts[entry.source] = (sourceCounts[entry.source] ?? 0) + 1;
    const key = `${entry.source}/${entry.bot}`;
    if (botCounts[key] !== undefined) botCounts[key] = (botCounts[key] ?? 0) + 1;
  }
  return { sources: sourceCounts, bots: botCounts, via: 'manifest' };
}

function belongsToBot(slug: string, bot: string): boolean {
  return slug === bot || slug.startsWith(`${bot}/`);
}

export function createGbrainClient(bin: string, spawnFn: SpawnFn = spawnGbrain): BrainClient {
  return {
    async ensureSource(source, directory) {
      const result = await spawnFn(addSourceArgv(bin, source, directory));
      if (result.code === 0) return { ok: true };
      if (ALREADY.test(result.stdout) || ALREADY.test(result.stderr)) return { ok: true };
      return { ok: false };
    },
    async putPage(source, slug, file) {
      const result = await spawnFn(putArgv(bin, source, slug, file));
      return { ok: result.code === 0 };
    },
    async counts(sources, bots, manifest) {
      const stats = await spawnFn(statsArgv(bin));
      const parsed = stats.code === 0 ? parseSourceCounts(stats.stdout) : null;
      if (!parsed) return manifestCounts(sources, bots, manifest);
      const sourceCounts: Record<string, number> = {};
      for (const source of sources) sourceCounts[source] = parsed[source] ?? 0;
      const botCounts: Record<string, number> = {};
      let listOk = true;
      for (const source of sources) {
        const listed = await spawnFn(listArgv(bin, source));
        const slugs = listed.code === 0 ? parseSlugList(listed.stdout) : null;
        if (!slugs) { listOk = false; break; }
        for (const bot of bots.filter((item) => item.source === source)) {
          botCounts[`${source}/${bot.bot}`] = slugs.filter((slug) => belongsToBot(slug, bot.bot)).length;
        }
      }
      if (!listOk) {
        const fallback = manifestCounts(sources, bots, manifest);
        return { sources: sourceCounts, bots: fallback.bots, via: 'stats' };
      }
      return { sources: sourceCounts, bots: botCounts, via: 'stats' };
    },
  };
}

export function loadManifestCounts(path: string, sources: string[], bots: { source: string; bot: string }[]): PageCounts {
  return manifestCounts(sources, bots, readManifest(path));
}
