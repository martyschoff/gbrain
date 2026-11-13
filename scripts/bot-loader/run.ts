import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import type { LoaderConfig, GroupConfig } from './config.ts';
import { assertRoutes } from './config.ts';
import { isInside, toPosix, writeAtomic } from './files.ts';
import { acquireLock, LockBusy, readExpectedHost, serveLockHeld, shareIsMounted, shortHostname } from './host.ts';
import type { BrainClient } from './gbrain-client.ts';
import { createGbrainClient } from './gbrain-client.ts';
import { readManifest, writeManifest, type Manifest, type ManifestEntry } from './manifest.ts';
import { openStage, publishPage, type PublishResult } from './publish.ts';
import { bodyForExtension, pageSlug, renderPage, sha256 } from './render.ts';
import { checkFailClosed, type PlannedFile } from './fail-closed.ts';
import { planExportRoots, type ExportPage } from './multi-account.ts';
import { scanTree } from './scan.ts';
import { formatSummary, type BotSummary, type RunSummary } from './summary.ts';

export interface RunOptions {
  config: LoaderConfig;
  hostname?: string;
  isMounted?: (shareRoot: string) => boolean;
  brain?: BrainClient;
  now?: Date;
  stderr?: (line: string) => void;
  /** When set, skips the PGLite lock read. True means serve holds the lock. */
  serveLockHeld?: boolean;
  /** Test hook: runs after a bot drop is verified and before the manifest is read again. */
  exportRecheck?: (botDir: string) => void;
}

export interface RunResult {
  exitCode: number;
  summaryText: string;
}

interface PublishEnv {
  stageDir: string;
  holdDir?: string;
  warnings: string[];
  syncOnce: (source: string) => Promise<boolean>;
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
  if (!existsSync(stamp)) {
    if (perBotDrop(directory)) return null;
    return 'box-export stamp missing';
  }
  const first = readFileSync(stamp, 'utf8').split(/\r?\n/)[0]?.trim() ?? '';
  const when = Date.parse(first);
  if (Number.isNaN(when)) return 'box-export stamp missing';
  if (now.getTime() - when > maxAgeHours * 60 * 60 * 1000) return 'box-export stale';
  return null;
}

/** A per-bot drop has a `manifest.json` in each bot folder and no top-level `EXPORTED_AT`. */
function perBotDrop(directory: string): boolean {
  let names: string[] = [];
  try { names = readdirSync(directory); } catch { return false; }
  return names.some((name) => existsSync(join(directory, name, 'manifest.json')));
}

function assertDestination(groups: GroupConfig[], group: GroupConfig, output: string): void {
  if (!isInside(group.targetRoot, output)) throw new Error('refusing a write outside the group target');
  for (const other of groups) {
    if (other.source === group.source) continue;
    if (isInside(other.targetRoot, output)) throw new Error(`refusing a ${group.source} write inside source ${other.source}`);
  }
}

const WRONG_HOST_STATUS = 'bot-loader: skipped: wrong host\nWARN hostname does not match GBRAIN_EXPECTED_HOST\n';

function gitRemoteRefusal(group: GroupConfig): string | null {
  if (!group.forbidGit) return null;
  if (!existsSync(join(group.targetRoot, '.git'))) return null;
  let output = '';
  try {
    output = execFileSync('git', ['-C', group.targetRoot, 'remote'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return `source ${group.source} git remote check failed; refusing to write`;
  }
  if (output.trim() !== '') return `source ${group.source} has a git remote; refusing to write`;
  return null;
}

export async function runLoader(opts: RunOptions): Promise<RunResult> {
  const stderr = opts.stderr ?? ((line) => process.stderr.write(line.endsWith('\n') ? line : `${line}\n`));
  const config = opts.config;
  assertRoutes(config.groups);
  if (config.placeholder) {
    stderr(`bot-loader: refusing to run; ${config.placeholder}. Edit the config and remove example placeholders.`);
    return { exitCode: 1, summaryText: '' };
  }
  if (!isAbsolute(config.gbrainBin)) {
    stderr(`bot-loader: gbrain_bin must be an absolute path (got ${config.gbrainBin})`);
    return { exitCode: 1, summaryText: '' };
  }
  const host = readExpectedHost(config.hostEnv);
  if (!host.ok) {
    stderr(`bot-loader: ${config.hostEnv} ${host.reason === 'missing_file' ? 'is missing' : 'has no GBRAIN_EXPECTED_HOST'}; nothing was changed`);
    return { exitCode: 1, summaryText: '' };
  }
  const hostname = opts.hostname ?? shortHostname();
  if (hostname !== host.expected) {
    writeAtomic(config.summaryPath, WRONG_HOST_STATUS, 0o600);
    stderr('bot-loader: this machine does not match GBRAIN_EXPECTED_HOST; exiting');
    return { exitCode: 0, summaryText: WRONG_HOST_STATUS };
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
    const home = process.env.HOME ?? '';
    const lockHeld = opts.serveLockHeld ?? serveLockHeld(join(home, '.gbrain', 'brain.pglite'));
    return await runLocked(config, opts.brain ?? createGbrainClient(config.gbrainBin), opts.now ?? new Date(), lockHeld, opts.exportRecheck);
  } finally {
    release();
  }
}

async function runLocked(config: LoaderConfig, brain: BrainClient, now: Date, serveHeld: boolean, recheck?: (botDir: string) => void): Promise<RunResult> {
  const warnings: string[] = [];
  const box = boxWarning(config.boxExportDir, config.boxExportMaxAgeHours, now);
  if (box) warnings.push(box);
  if (serveHeld) warnings.push('live brain totals are unavailable while serve runs');
  const manifest = readManifest(config.statePath);
  const roots = [...config.groups.map((group) => group.targetRoot), ...config.exportRoots.map((root) => root.targetRoot)];
  const stage = openStage(roots, dirname(config.statePath));
  const holdDir = join(dirname(config.statePath), 'loader-held');
  const holdOutside = roots.every((root) => root && !isInside(root, holdDir) && !isInside(holdDir, root));
  const synced = new Map<string, Promise<boolean>>();
  const env: PublishEnv = {
    stageDir: stage.dir,
    ...(holdOutside ? { holdDir } : {}),
    warnings,
    syncOnce: (source) => {
      let pending = synced.get(source);
      if (!pending) {
        pending = (async () => {
          if (!brain.syncSource) return false;
          const result = await brain.syncSource(source);
          if (!result.ok) {
            warnings.push(`sync ${source} failed (${result.detail ?? 'exit 1'})`);
            return false;
          }
          return true;
        })();
        synced.set(source, pending);
      }
      return pending;
    },
  };
  try {
  const seen = new Set<string>();
  const bots: BotSummary[] = [];
  const skips: string[] = [];
  let ok = true;
  const allowCache = new Map<string, Set<string>>();

  for (const group of config.groups) {
    if (group.failClosed) {
      const closed = await runFailClosedGroup(config, group, brain, manifest, seen, now, env);
      bots.push(...closed.bots);
      if (closed.skip) skips.push(`SKIP ${group.source}: ${closed.skip}`);
      if (!closed.putOk) ok = false;
      continue;
    }
    const remoteRefusal = gitRemoteRefusal(group);
    if (remoteRefusal) {
      warnings.push(remoteRefusal);
      ok = false;
      for (const bot of group.bots) bots.push(emptyBot(bot.id, group.source));
      continue;
    }
    if (group.ensureSource && !manifest.sources?.[group.source]?.added) {
      mkdirSync(group.targetRoot, { recursive: true });
      const ensured = await brain.ensureSource(group.source, group.targetRoot);
      if (!ensured.ok) {
        warnings.push(`source ${group.source} was not created`);
        ok = false;
        for (const bot of group.bots) bots.push(emptyBot(bot.id, group.source));
        continue;
      }
      manifest.sources = { ...manifest.sources, [group.source]: { added: true } };
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
        if (config.exportRoots.some((root) => isInside(root.path, input.path) || isInside(input.path, root.path))) {
          warnings.push(`input covered by export root bot=${bot.id}`);
          continue;
        }
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
          const slug = `${bot.id}/${pageSlug(outputRel)}`;
          const output = join(group.targetRoot, `${slug}.md`);
          assertDestination(config.groups, group, output);
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
          const published = await publishPage({
            brain, source: group.source, slug, canonicalPath: output, body: page, stageDir: env.stageDir,
            prior, manifest, warnings, syncOnce: env.syncOnce, holdDir: env.holdDir,
          });
          const wrote = notePublish(manifest, summary, file.absolute, prior, {
            sha256: digest,
            bot: bot.id,
            source: group.source,
            slug,
            output,
            originRelpath: originOf(config.shareRoot, file.absolute, bot.id, index, file.relativePosix),
          }, published);
          if (!wrote) ok = false;
        }
      }
      summary.pages = 0;
      bots.push(summary);
    }
  }

  const plannedRoots = planExportRoots(config.exportRoots, {
    recheck,
    maxBytes: config.maxBytes,
    now,
    maxAgeHours: config.boxExportMaxAgeHours,
  });
  const exportActive: { source: string; bot: string }[] = [];
  for (const root of plannedRoots) {
    warnings.push(...root.warnings);
    exportActive.push(...root.active);
    const needsSource = root.ensureSource && root.bots.some((bot) => bot.pages.length > 0);
    if (needsSource && !manifest.sources?.[root.source]?.added) {
      mkdirSync(root.targetRoot, { recursive: true });
      const ensured = await brain.ensureSource(root.source, root.targetRoot);
      if (!ensured.ok) {
        warnings.push(`export ${root.account}: source not created`);
        ok = false;
        for (const bot of root.bots) bots.push(bot.summary);
        continue;
      }
      manifest.sources = { ...manifest.sources, [root.source]: { added: true } };
    }
    for (const bot of root.bots) {
      for (const page of bot.pages) {
        const wrote = await commitExport(config, brain, manifest, seen, bot.summary, page, env);
        if (!wrote) ok = false;
      }
      bots.push(bot.summary);
    }
  }

  writeManifest(config.statePath, manifest);
  const activeBots = [
    ...config.groups.flatMap((group) => group.bots.map((bot) => ({ source: group.source, bot: bot.id }))),
    ...exportActive,
  ];
  const sourceIds = [...new Set([...config.groups.map((group) => group.source), ...config.exportRoots.map((root) => root.source)])];
  const counts = await brain.counts(sourceIds, activeBots, manifest);
  for (const bot of bots) bot.pages = counts.bots[`${bot.source}/${bot.id}`] ?? 0;
  const configured = new Set(activeBots.map((bot) => `${bot.source}/${bot.bot}`));
  const orphanLines = orphanLinesFor(manifest, configured, seen);
  const stuck = Object.values(manifest.files).filter((entry) => entry.pending && (entry.pendingAttempts ?? 0) >= 3).length;
  if (stuck > 0) warnings.push(`stuck pending ${stuck}`);
  const summary: RunSummary = {
    ok,
    bots,
    sources: sourceIds.map((id) => ({ id, pages: counts.sources[id] ?? 0, via: counts.via })),
    orphans: orphanLines,
    warnings: warnings.filter((warning) => !warning.startsWith('orphaned ')),
    skips,
  };
  const text = formatSummary(summary);
  writeAtomic(config.summaryPath, text, 0o600);
  return { exitCode: ok ? 0 : 1, summaryText: text };
  } finally {
    stage.close();
  }
}

async function runFailClosedGroup(
  config: LoaderConfig,
  group: GroupConfig,
  brain: BrainClient,
  manifest: Manifest,
  seen: Set<string>,
  now: Date,
  env: PublishEnv,
): Promise<{ bots: BotSummary[]; skip: string | null; putOk: boolean }> {
  const blanks = () => group.bots.map((bot) => emptyBot(bot.id, group.source));
  if (group.bots.length === 0) return { bots: [], skip: 'no bots named', putOk: true };
  const checked = checkFailClosed(group, {
    groups: config.groups,
    now,
    maxBytes: config.maxBytes,
    maxAgeHours: config.boxExportMaxAgeHours,
  });
  if (!checked.ok) return { bots: blanks(), skip: checked.skip, putOk: true };
  if (group.ensureSource && !manifest.sources?.[group.source]?.added) {
    const ensured = await brain.ensureSource(group.source, group.targetRoot);
    if (!ensured.ok) return { bots: blanks(), skip: 'source not created', putOk: true };
    manifest.sources = { ...manifest.sources, [group.source]: { added: true } };
  }
  const summaries = new Map(group.bots.map((bot) => [bot.id, emptyBot(bot.id, group.source)]));
  let putOk = true;
  for (const file of checked.files) {
    const summary = summaries.get(file.botId);
    if (!summary) return { bots: blanks(), skip: 'route', putOk: true };
    summary.scanned++;
    const wrote = await commitPlanned(config, group, brain, manifest, seen, summary, file, env);
    if (!wrote) putOk = false;
  }
  return { bots: group.bots.map((bot) => summaries.get(bot.id)!), skip: null, putOk };
}

async function commitPlanned(
  config: LoaderConfig,
  group: GroupConfig,
  brain: BrainClient,
  manifest: Manifest,
  seen: Set<string>,
  summary: BotSummary,
  file: PlannedFile,
  env: PublishEnv,
): Promise<boolean> {
  const digest = sha256(file.bytes);
  seen.add(file.absolute);
  const prior = manifest.files[file.absolute];
  const slug = `${file.botId}/${pageSlug(file.outputRel)}`;
  const output = join(group.targetRoot, `${slug}.md`);
  if (prior && prior.sha256 === digest && prior.inBrain && prior.output === output && prior.slug === slug) {
    summary.unchanged++;
    return true;
  }
  const ext = file.relativePosix.includes('.') ? file.relativePosix.slice(file.relativePosix.lastIndexOf('.')) : '';
  const page = renderPage({
    relativeMd: `${file.botId}/${file.outputRel}`,
    title: basename(file.outputRel).replace(/\.md$/, ''),
    originRelpath: originOf(config.shareRoot, file.absolute, file.botId, file.inputIndex, file.relativePosix),
    originSha256: digest,
    body: bodyForExtension(ext, file.bytes.toString('utf8'), config.csvMaxRows),
  });
  if (pageSlug(`${file.botId}/${file.outputRel}`) !== slug) throw new Error('slug drifted from the output path');
  if (!isInside(group.targetRoot, output)) throw new Error('route check failed');
  const published = await publishPage({
    brain, source: group.source, slug, canonicalPath: output, body: page, stageDir: env.stageDir,
    prior, manifest, warnings: env.warnings, syncOnce: env.syncOnce, holdDir: env.holdDir,
  });
  return notePublish(manifest, summary, file.absolute, prior, {
    sha256: digest,
    bot: file.botId,
    source: group.source,
    slug,
    output,
    originRelpath: originOf(config.shareRoot, file.absolute, file.botId, file.inputIndex, file.relativePosix),
  }, published);
}

async function commitExport(
  config: LoaderConfig,
  brain: BrainClient,
  manifest: Manifest,
  seen: Set<string>,
  summary: BotSummary,
  page: ExportPage,
  env: PublishEnv,
): Promise<boolean> {
  const digest = sha256(page.bytes);
  seen.add(page.absolute);
  const owner = destinationGroup(config, page);
  const relativeMd = mdRelative(page.relativePosix);
  const slug = `${page.account}/${page.botId}/${pageSlug(relativeMd)}`;
  const output = join(owner.targetRoot, `${slug}.md`);
  assertDestination(config.groups.concat(owner), owner, output);
  const prior = manifest.files[page.absolute];
  if (prior && prior.sha256 === digest && prior.inBrain && prior.output === output && prior.slug === slug) {
    summary.unchanged++;
    return true;
  }
  const ext = page.relativePosix.includes('.') ? page.relativePosix.slice(page.relativePosix.lastIndexOf('.')) : '';
  const origin = originOfExport(config.shareRoot, page.absolute, page.account, page.botId, page.relativePosix);
  const rendered = renderPage({
    relativeMd: `${page.account}/${page.botId}/${relativeMd}`,
    title: basename(relativeMd).replace(/\.md$/, ''),
    originRelpath: origin,
    originSha256: digest,
    body: bodyForExtension(ext, page.bytes.toString('utf8'), config.csvMaxRows),
    account: page.account,
    bot: page.botId,
    botName: page.botName,
  });
  if (pageSlug(`${page.account}/${page.botId}/${relativeMd}`) !== slug) throw new Error('slug drifted from the output path');
  const published = await publishPage({
    brain, source: page.source, slug, canonicalPath: output, body: rendered, stageDir: env.stageDir,
    prior, manifest, warnings: env.warnings, syncOnce: env.syncOnce, holdDir: env.holdDir,
  });
  return notePublish(manifest, summary, page.absolute, prior, {
    sha256: digest,
    bot: `${page.account}/${page.botId}`,
    source: page.source,
    slug,
    output,
    originRelpath: origin,
  }, published);
}

function destinationGroup(config: LoaderConfig, page: ExportPage): GroupConfig {
  const existing = config.groups.find((group) => group.source === page.source && group.targetRoot === page.targetRoot);
  if (existing) return existing;
  return {
    id: `export-${page.account}`,
    source: page.source,
    targetRoot: page.targetRoot,
    extensions: [],
    ensureSource: false,
    forbidGit: false,
    bots: [],
    failClosed: false,
  };
}

function originOfExport(shareRoot: string, absolute: string, account: string, botId: string, relativePosix: string): string {
  if (isInside(shareRoot, absolute)) return toPosix(relative(shareRoot, absolute));
  return `external/${account}/${botId}/${relativePosix}`;
}

function notePublish(
  manifest: Manifest,
  summary: BotSummary,
  key: string,
  prior: ManifestEntry | undefined,
  base: Omit<ManifestEntry, 'inBrain' | 'pending' | 'pendingAttempts' | 'revision'>,
  result: PublishResult,
): boolean {
  if (result.status === 'skipped') return true;
  if (result.status === 'failed' && prior?.inBrain) return false;
  const attempts = result.status === 'pending'
    ? (prior && prior.sha256 === base.sha256 ? (prior.pendingAttempts ?? 0) : 0) + 1
    : 0;
  const entry: ManifestEntry = {
    ...base,
    inBrain: result.status === 'written',
    pending: result.status === 'pending',
    ...(result.status === 'pending' ? { pendingAttempts: attempts } : {}),
    ...(result.status === 'written' && result.revision ? { revision: result.revision } : {}),
  };
  manifest.files[key] = entry;
  if (result.status === 'pending') return true;
  if (result.status !== 'written') return false;
  summary.written++;
  return true;
}

function emptyBot(id: string, source: string): BotSummary {
  return { id, source, scanned: 0, written: 0, unchanged: 0, skipped: 0, secretsSkipped: 0, pages: 0 };
}

function orphanLinesFor(manifest: Manifest, configured: Set<string>, seen: Set<string>): { bot: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const [path, entry] of Object.entries(manifest.files)) {
    const key = `${entry.source}/${entry.bot}`;
    const botGone = !configured.has(key);
    const sourceGone = !botGone && !seen.has(path) && !existsSync(path);
    if (!botGone && !sourceGone) continue;
    counts.set(entry.bot, (counts.get(entry.bot) ?? 0) + 1);
  }
  return [...counts.entries()].map(([bot, count]) => ({ bot, count }));
}
