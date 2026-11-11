import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath } from 'node:path';
import type { LoaderConfig, GroupConfig } from './config.ts';
import { assertRoutes } from './config.ts';
import { isInside, toPosix, writeAtomic } from './files.ts';
import { acquireLock, LockBusy, readExpectedHost, shareIsMounted, shortHostname } from './host.ts';
import type { BrainClient } from './gbrain-client.ts';
import { createGbrainClient } from './gbrain-client.ts';
import { readManifest, writeManifest, type Manifest, type ManifestEntry } from './manifest.ts';
import { bodyForExtension, pageSlug, renderPage, sha256 } from './render.ts';
import { scanTree } from './scan.ts';
import { formatSummary, type BotSummary, type RunSummary } from './summary.ts';

export interface RunOptions {
  config: LoaderConfig;
  hostname?: string;
  isMounted?: (shareRoot: string) => boolean;
  brain?: BrainClient;
  now?: Date;
  stderr?: (line: string) => void;
}

export interface RunResult {
  exitCode: number;
  summaryText: string;
}

function mdRelative(relativePosix: string): string {
  const slash = relativePosix.lastIndexOf('/');
  const dir = slash >= 0 ? relativePosix.slice(0, slash + 1) : '';
  const name = slash >= 0 ? relativePosix.slice(slash + 1) : relativePosix;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${dir}${stem}.md`;
}

function originOf(shareRoot: string, absolute: string, botId: string, index: number, relativePosix: string): string {
  if (isInside(shareRoot, absolute)) return toPosix(relative(shareRoot, absolute));
  return `external/${botId}/${index}/${relativePosix}`;
}

function boxWarning(directory: string, maxAgeHours: number, now: Date): string | null {
  if (!existsSync(directory)) return 'box-export missing';
  const stamp = join(directory, 'EXPORTED_AT');
  if (!existsSync(stamp)) return 'box-export stamp missing';
  const first = readFileSync(stamp, 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
  const when = Date.parse(first);
  if (Number.isNaN(when)) return 'box-export stamp missing';
  if (now.getTime() - when > maxAgeHours * 60 * 60 * 1000) return 'box-export stale';
  return null;
}

function assertDestination(groups: GroupConfig[], group: GroupConfig, output: string): void {
  if (!isInside(group.targetRoot, output)) throw new Error('refusing a write outside the group target');
  for (const other of groups) {
    if (other.source === group.source) continue;
    if (isInside(other.targetRoot, output)) throw new Error(`refusing a ${group.source} write inside source ${other.source}`);
  }
}

export async function runLoader(opts: RunOptions): Promise<RunResult> {
  const stderr = opts.stderr ?? ((line) => process.stderr.write(line.endsWith('\n') ? line : `${line}\n`));
  const config = opts.config;
  assertRoutes(config.groups);
  const host = readExpectedHost(config.hostEnv);
  if (!host.ok) {
    stderr(`bot-loader: ${config.hostEnv} ${host.reason === 'missing_file' ? 'is missing' : 'has no GBRAIN_EXPECTED_HOST'}; nothing was changed`);
    return { exitCode: 1, summaryText: '' };
  }
  const hostname = opts.hostname ?? shortHostname();
  if (hostname !== host.expected) {
    stderr('bot-loader: this machine does not match GBRAIN_EXPECTED_HOST; exiting');
    return { exitCode: 0, summaryText: '' };
  }
  const mounted = opts.isMounted ?? shareIsMounted;
  if (!mounted(config.shareRoot)) {
    stderr(`bot-loader: share root is not a mounted filesystem; nothing was changed`);
    return { exitCode: 1, summaryText: '' };
  }

  let release: (() => void) | null = null;
  try {
    release = acquireLock(config.lockPath);
  } catch (error) {
    if (error instanceof LockBusy) {
      stderr(error.message);
      return { exitCode: 1, summaryText: '' };
    }
    throw error;
  }

  try {
    return await runLocked(config, opts.brain ?? createGbrainClient(config.gbrainBin), opts.now ?? new Date());
  } finally {
    release();
  }
}

async function runLocked(config: LoaderConfig, brain: BrainClient, now: Date): Promise<RunResult> {
  const warnings: string[] = [];
  const box = boxWarning(config.boxExportDir, config.boxExportMaxAgeHours, now);
  if (box) warnings.push(box);
  const manifest = readManifest(config.statePath);
  const seen = new Set<string>();
  const bots: BotSummary[] = [];
  let ok = true;
  const allowCache = new Map<string, Set<string>>();

  for (const group of config.groups) {
    if (group.forbidGit && existsSync(join(group.targetRoot, '.git'))) {
      warnings.push(`source ${group.source} has git metadata; skipped`);
      ok = false;
      for (const bot of group.bots) bots.push(emptyBot(bot.id, group.source));
      continue;
    }
    if (group.ensureSource) {
      mkdirSync(group.targetRoot, { recursive: true });
      const ensured = await brain.ensureSource(group.source, group.targetRoot);
      if (!ensured.ok) {
        warnings.push(`source ${group.source} was not created`);
        ok = false;
        for (const bot of group.bots) bots.push(emptyBot(bot.id, group.source));
        continue;
      }
    }
    for (const bot of group.bots) {
      const summary = emptyBot(bot.id, group.source);
      const claimed = new Set<string>();
      for (let index = 0; index < bot.inputs.length; index++) {
        const input = bot.inputs[index]!;
        const covered = bot.inputs.some((other, otherIndex) => otherIndex !== index
          && existsSync(other.path)
          && resolvePath(other.path) !== resolvePath(input.path)
          && isInside(other.path, input.path));
        if (covered) continue;
        if (!existsSync(input.path)) {
          warnings.push(`${input.required ? 'required' : 'optional'} input missing bot=${bot.id}`);
          continue;
        }
        if (isInside(group.targetRoot, input.path) || isInside(input.path, group.targetRoot)) {
          warnings.push(`input overlaps target bot=${bot.id}`);
          continue;
        }
        let allow = allowCache.get(group.source);
        if (!allow) { allow = new Set(group.extensions); allowCache.set(group.source, allow); }
        const scanned = scanTree(input.path, allow, config.maxBytes);
        summary.scanned += scanned.counts.scanned;
        summary.skipped += scanned.counts.skipped;
        summary.secretsSkipped += scanned.counts.secrets;
        for (const file of scanned.files) {
          const digest = sha256(file.bytes);
          seen.add(file.absolute);
          const prior = manifest.files[file.absolute];
          const relativeMd = mdRelative(file.relativePosix);
          let outputRel = relativeMd;
          let n = 2;
          while (claimed.has(outputRel)) {
            outputRel = relativeMd.replace(/\.md$/, `~${n}.md`);
            n++;
          }
          claimed.add(outputRel);
          const output = join(group.targetRoot, bot.id, outputRel);
          assertDestination(config.groups, group, output);
          const slug = `${bot.id}/${pageSlug(outputRel)}`;
          if (prior && prior.sha256 === digest && prior.inBrain && prior.output === output && prior.slug === slug) {
            summary.unchanged++;
            continue;
          }
          const ext = file.relativePosix.includes('.') ? file.relativePosix.slice(file.relativePosix.lastIndexOf('.')) : '';
          const text = file.bytes.toString('utf8');
          const page = renderPage({
            relativeMd: `${bot.id}/${outputRel}`,
            title: basename(outputRel).replace(/\.md$/, ''),
            originRelpath: originOf(config.shareRoot, file.absolute, bot.id, index, file.relativePosix),
            originSha256: digest,
            body: bodyForExtension(ext, text, config.csvMaxRows),
          });
          if (pageSlug(`${bot.id}/${outputRel}`) !== slug) throw new Error('slug drifted from the output path');
          if (!slug.startsWith(`${bot.id}/`) || !isInside(group.targetRoot, output)) throw new Error('route check failed');
          writeAtomic(output, page, 0o644);
          const put = await brain.putPage(group.source, slug, output);
          const entry: ManifestEntry = {
            sha256: digest,
            bot: bot.id,
            source: group.source,
            slug,
            output,
            originRelpath: originOf(config.shareRoot, file.absolute, bot.id, index, file.relativePosix),
            inBrain: put.ok,
          };
          manifest.files[file.absolute] = entry;
          if (!put.ok) { ok = false; continue; }
          summary.written++;
        }
      }
      const orphans = orphanCount(manifest, bot.id, group.source, seen);
      summary.pages = 0;
      bots.push(summary);
      if (orphans > 0) warnings.push(`orphaned ${bot.id} ${orphans}`);
    }
  }

  writeManifest(config.statePath, manifest);
  const counts = await brain.counts(
    [...new Set(config.groups.map((group) => group.source))],
    config.groups.flatMap((group) => group.bots.map((bot) => ({ source: group.source, bot: bot.id }))),
    manifest,
  );
  for (const bot of bots) bot.pages = counts.bots[`${bot.source}/${bot.id}`] ?? 0;
  if (counts.via === 'manifest') warnings.push('page counts from loader manifest');
  const orphanLines = config.groups.flatMap((group) => group.bots.map((bot) => {
    const count = orphanCount(manifest, bot.id, group.source, seen);
    return { bot: bot.id, count };
  })).filter((item) => item.count > 0);
  const summary: RunSummary = {
    ok,
    bots,
    sources: [...new Set(config.groups.map((group) => group.source))].map((id) => ({ id, pages: counts.sources[id] ?? 0, via: counts.via })),
    orphans: orphanLines,
    warnings: warnings.filter((warning) => !warning.startsWith('orphaned ')),
  };
  const text = formatSummary(summary);
  writeAtomic(config.summaryPath, text, 0o600);
  return { exitCode: ok ? 0 : 1, summaryText: text };
}

function emptyBot(id: string, source: string): BotSummary {
  return { id, source, scanned: 0, written: 0, unchanged: 0, skipped: 0, secretsSkipped: 0, pages: 0 };
}

function orphanCount(manifest: Manifest, bot: string, source: string, seen: Set<string>): number {
  let count = 0;
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.bot !== bot || entry.source !== source || seen.has(path)) continue;
    if (!existsSync(path)) count++;
  }
  return count;
}
