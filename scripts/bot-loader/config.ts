import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { expandHome, isInside } from './files.ts';

export interface InputFolder {
  path: string;
  required: boolean;
  /** box-export inputs are still read when the stamp is stale; the run only warns. */
  role?: 'box-export' | 'local-feed';
}

export interface BotConfig {
  id: string;
  inputs: InputFolder[];
}

export interface GroupConfig {
  id: string;
  source: string;
  targetRoot: string;
  extensions: string[];
  ensureSource: boolean;
  /** finance must stay a plain directory: no git metadata. */
  forbidGit: boolean;
  bots: BotConfig[];
  /** Whole-group checks. Omitted or false keeps today's per-file warn path. */
  failClosed: boolean;
  /** Required when failClosed. Compared to the feed manifest. */
  account?: string;
  /** Required when failClosed. Stamp checks read only this directory. */
  stampRoot?: string;
  /** Business feeds set this and it must be the same directory as stampRoot. */
  boxExportDir?: string;
}

/** One nightly drop root. The directory name is `_box-export` or `_box-export-<account>`. */
export interface ExportRootConfig {
  account: string;
  path: string;
  source: string;
  targetRoot: string;
  ensureSource: boolean;
}

export interface LoaderConfig {
  shareRoot: string;
  statePath: string;
  summaryPath: string;
  lockPath: string;
  hostEnv: string;
  gbrainBin: string;
  maxBytes: number;
  csvMaxRows: number;
  boxExportMaxAgeHours: number;
  boxExportDir: string;
  /** Set when the file still contains example bot ids, the example share root, or __SET_ME__. */
  placeholder: string | null;
  groups: GroupConfig[];
  /** Nightly per-bot drops. Empty when the config does not list any. */
  exportRoots: ExportRootConfig[];
}

const PERSONAL_EXTENSIONS = ['.md', '.txt', '.json', '.yaml', '.yml'];
const FINANCE_EXTENSIONS = [...PERSONAL_EXTENSIONS, '.csv'];
const PLACEHOLDER_BOTS = new Set(['bot-a', 'bot-b', 'fin-bot']);
const EXAMPLE_SHARE = '~/mnt/netfs';

interface RawInput {
  path?: unknown;
  required?: unknown;
  role?: unknown;
}

interface RawBot {
  id?: unknown;
  inputs?: unknown;
}

interface RawGroup {
  id?: unknown;
  source?: unknown;
  target_root?: unknown;
  extensions?: unknown;
  ensure_source?: unknown;
  forbid_git?: unknown;
  bots?: unknown;
  fail_closed?: unknown;
  account?: unknown;
  stamp_root?: unknown;
  box_export_dir?: unknown;
}

/** True when both paths exist and name the same directory after symlinks. */
function sameRealpath(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false;
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`config: ${label} must be a non-empty string`);
  return value.trim();
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error('config: expected a boolean');
  return value;
}

function expandShare(value: string, shareRoot: string, home: string): string {
  const withHome = expandHome(value, home);
  return withHome.split('<share>').join(shareRoot);
}

function defaultInputs(shareRoot: string, botId: string): InputFolder[] {
  return [
    { path: join(shareRoot, 'personalgrok', botId), required: false },
    { path: join(shareRoot, 'personalgrok', 'gbrain', '_box-export', botId), required: false, role: 'box-export' },
  ];
}

function parseInputs(raw: unknown, shareRoot: string, home: string, botId: string, failClosed: boolean): InputFolder[] {
  if (raw === undefined) {
    if (failClosed) throw new Error(`config: fail-closed bot ${botId} needs inputs`);
    return defaultInputs(shareRoot, botId);
  }
  if (!Array.isArray(raw)) throw new Error(`config: bot ${botId} inputs must be a list`);
  if (failClosed && raw.length === 0) throw new Error(`config: fail-closed bot ${botId} needs inputs`);
  return raw.map((item, index) => {
    const row = item as RawInput;
    const role = row.role === undefined ? undefined : asString(row.role, `inputs[${index}].role`);
    if (role !== undefined && role !== 'box-export' && role !== 'local-feed') throw new Error(`config: unknown input role ${role}`);
    return {
      path: expandShare(asString(row.path, `bot ${botId} inputs[${index}].path`), shareRoot, home),
      required: asBool(row.required, false),
      ...(role === 'box-export' || role === 'local-feed' ? { role } : {}),
    };
  });
}

function parseExtensions(raw: unknown, source: string, failClosed: boolean): string[] {
  const base = source === 'finance'
    ? FINANCE_EXTENSIONS
    : failClosed && source === 'hermes'
      ? ['.md', '.txt']
      : PERSONAL_EXTENSIONS;
  if (raw === undefined) return base;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`config: extensions for source ${source} must be a non-empty list`);
  return raw.map((item, index) => {
    const ext = asString(item, `extensions[${index}]`).toLowerCase();
    if (!ext.startsWith('.')) throw new Error(`config: extension ${ext} must start with a dot`);
    return ext;
  });
}

function pathsAreSame(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  if (a === b) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** True when both sides name one directory. A missing side is equal only when neither exists and the resolved paths match. */
function pathsConfirmedEqual(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  const aExists = existsSync(a);
  const bExists = existsSync(b);
  if (aExists && bExists) {
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  }
  if (!aExists && !bExists) return a === b;
  return false;
}

function validateFailClosed(group: GroupConfig, raw: RawGroup, personalBox: string, financeTargets: string[]): void {
  if (!group.failClosed) return;
  if (group.source === 'finance') throw new Error(`config: fail-closed group ${group.id} cannot be finance`);
  if (group.source !== 'business' && group.source !== 'hermes') {
    throw new Error(`config: fail-closed source ${group.source} is not business or hermes`);
  }
  if (!group.account || !group.stampRoot) throw new Error(`config: fail-closed group ${group.id} needs account and stamp_root`);
  if (group.source === 'business' && group.account !== 'businessgrok') {
    throw new Error(`config: business group ${group.id} account must be businessgrok`);
  }
  if (group.source === 'hermes' && group.account !== 'hermes') {
    throw new Error(`config: hermes group ${group.id} account must be hermes`);
  }
  if (group.forbidGit) throw new Error(`config: fail-closed group ${group.id} cannot set forbid_git`);
  if (group.extensions.includes('.csv')) throw new Error(`config: fail-closed group ${group.id} cannot list .csv`);
  if (pathsAreSame(group.stampRoot, personalBox)) {
    throw new Error(`config: fail-closed group ${group.id} stamp_root is the personal box export`);
  }
  if (financeTargets.some((target) => isInside(target, group.stampRoot!) || isInside(group.stampRoot!, target))) {
    throw new Error(`config: fail-closed group ${group.id} stamp_root overlaps a finance target`);
  }
  const hasBox = Object.prototype.hasOwnProperty.call(raw, 'box_export_dir');
  if (group.source === 'business') {
    if (!group.boxExportDir || !pathsConfirmedEqual(group.boxExportDir, group.stampRoot)) {
      throw new Error(`config: business group ${group.id} box_export_dir must match stamp_root`);
    }
  } else if (hasBox) {
    throw new Error(`config: hermes group ${group.id} must not set box_export_dir`);
  }
  for (const bot of group.bots) {
    for (const input of bot.inputs) {
      if (!isInside(group.stampRoot, input.path)) {
        throw new Error(`config: fail-closed bot ${bot.id} input is outside stamp_root`);
      }
      if (financeTargets.some((target) => isInside(target, input.path) || isInside(input.path, target))) {
        throw new Error(`config: fail-closed bot ${bot.id} input is inside a finance target`);
      }
    }
  }
}

export function loadConfig(path: string, home: string): LoaderConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawShare = asString(parsed.share_root, 'share_root');
  const shareRoot = resolve(expandHome(rawShare, home));
  const shareConfirmed = parsed.share_root_confirmed === true;
  const personalBox = resolve(expandShare(typeof parsed.box_export_dir === 'string' ? parsed.box_export_dir : '<share>/personalgrok/gbrain/_box-export', shareRoot, home));
  const groupsRaw = parsed.groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) throw new Error('config: groups must be a non-empty list');
  const parsedGroups = groupsRaw.map((item, index) => {
    const group = item as RawGroup;
    const id = asString(group.id, `groups[${index}].id`);
    const source = asString(group.source, `groups[${index}].source`);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) {
      throw new Error(`config: group ${id} source ${source} must be a lowercase slug`);
    }
    const failClosed = asBool(group.fail_closed, false);
    const targetRoot = resolve(expandShare(asString(group.target_root, `group ${id} target_root`), shareRoot, home));
    const botsRaw = group.bots;
    if (!Array.isArray(botsRaw)) throw new Error(`config: group ${id} bots must be a list`);
    const bots: BotConfig[] = botsRaw.map((botItem, botIndex) => {
      const bot = botItem as RawBot;
      const botId = asString(bot.id, `group ${id} bots[${botIndex}].id`);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(botId)) throw new Error(`config: bot id ${botId} must be a lowercase slug`);
      return { id: botId, inputs: parseInputs(bot.inputs, shareRoot, home, botId, failClosed) };
    });
    const forbidGit = asBool(group.forbid_git, source === 'finance');
    const account = group.account === undefined ? undefined : asString(group.account, `group ${id} account`);
    const stampRoot = group.stamp_root === undefined
      ? undefined
      : resolve(expandShare(asString(group.stamp_root, `group ${id} stamp_root`), shareRoot, home));
    const boxExportDir = group.box_export_dir === undefined
      ? undefined
      : resolve(expandShare(asString(group.box_export_dir, `group ${id} box_export_dir`), shareRoot, home));
    const built: GroupConfig = {
      id,
      source,
      targetRoot,
      extensions: parseExtensions(group.extensions, source, failClosed),
      ensureSource: asBool(group.ensure_source, source === 'finance'),
      forbidGit,
      bots,
      failClosed,
      ...(account ? { account } : {}),
      ...(stampRoot ? { stampRoot } : {}),
      ...(boxExportDir ? { boxExportDir } : {}),
    };
    return { raw: group, built };
  });
  const financeTargets = parsedGroups.filter((item) => item.built.source === 'finance').map((item) => item.built.targetRoot);
  const groups: GroupConfig[] = parsedGroups.map((item) => {
    validateFailClosed(item.built, item.raw, personalBox, financeTargets);
    return item.built;
  });
  const seenBots = new Set<string>();
  const seenSources = new Map<string, string>();
  for (const group of groups) {
    const prior = seenSources.get(group.source);
    if (prior !== undefined && prior !== group.targetRoot) {
      throw new Error(`config: source ${group.source} is registered with two target directories`);
    }
    seenSources.set(group.source, group.targetRoot);
    for (const bot of group.bots) {
      const key = `${group.source}/${bot.id}`;
      if (seenBots.has(key)) throw new Error(`config: duplicate bot ${key}`);
      seenBots.add(key);
    }
  }
  const exportRoots = parseExportRoots(parsed.export_roots, shareRoot, home);
  validateExportRoots(exportRoots, groups, financeTargets);
  for (const root of exportRoots) {
    const prior = seenSources.get(root.source);
    if (prior !== undefined && prior !== root.targetRoot) {
      throw new Error(`config: source ${root.source} is registered with two target directories`);
    }
    seenSources.set(root.source, root.targetRoot);
  }
  assertRoutes([
    ...groups,
    ...exportRoots.map((root) => ({ id: `export-${root.account}`, source: root.source, targetRoot: root.targetRoot })),
  ]);
  const placeholderBot = groups.flatMap((group) => group.bots).find((bot) => PLACEHOLDER_BOTS.has(bot.id));
  const exampleRoot = resolve(join(home, 'mnt/netfs'));
  const exampleShare = !shareConfirmed && (rawShare === EXAMPLE_SHARE || shareRoot === exampleRoot || sameRealpath(shareRoot, exampleRoot));
  const placeholder = placeholderBot
    ? `bot id ${placeholderBot.id} is an example placeholder`
    : raw.includes('__SET_ME__')
      ? 'config contains __SET_ME__'
      : exampleShare
        ? 'share_root is the example ~/mnt/netfs'
        : null;
  return {
    shareRoot,
    statePath: resolve(expandHome(typeof parsed.state_path === 'string' ? parsed.state_path : '~/.gbrain/bot-loader/state.json', home)),
    summaryPath: resolve(expandHome(typeof parsed.summary_path === 'string' ? parsed.summary_path : '~/.gbrain/bot-loader/last-summary.txt', home)),
    lockPath: resolve(expandHome(typeof parsed.lock_path === 'string' ? parsed.lock_path : '~/.gbrain/bot-loader/run.lock', home)),
    hostEnv: resolve(expandHome(typeof parsed.host_env === 'string' ? parsed.host_env : '~/.gbrain/serve/host.env', home)),
    gbrainBin: typeof parsed.gbrain_bin === 'string' && parsed.gbrain_bin.trim() !== '' ? parsed.gbrain_bin.trim() : 'gbrain',
    maxBytes: typeof parsed.max_bytes === 'number' && parsed.max_bytes > 0 ? parsed.max_bytes : 1024 * 1024,
    csvMaxRows: typeof parsed.csv_max_rows === 'number' && parsed.csv_max_rows > 0 ? parsed.csv_max_rows : 500,
    boxExportMaxAgeHours: typeof parsed.box_export_max_age_hours === 'number' && parsed.box_export_max_age_hours > 0 ? parsed.box_export_max_age_hours : 36,
    boxExportDir: personalBox,
    placeholder,
    groups,
    exportRoots,
  };
}

/**
 * A finance source can only write under a directory named finance, and no
 * group's target may sit inside another group's target. Bots have no source
 * override: the group source is the only destination.
 */
export function assertRoutes(groups: Pick<GroupConfig, 'id' | 'source' | 'targetRoot'>[]): void {
  for (const group of groups) {
    if (!isAbsolute(group.targetRoot)) throw new Error(`config: group ${group.id} target_root is not absolute`);
    if (group.source === 'finance') {
      const base = group.targetRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
      if (base !== 'finance') throw new Error(`config: finance source target_root must be the finance directory (group ${group.id})`);
    }
  }
  for (const group of groups) {
    for (const other of groups) {
      if (other.source === group.source) continue;
      const child = resolve(group.targetRoot);
      const parent = resolve(other.targetRoot);
      if (child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/')) {
        throw new Error(`config: group ${group.id} target overlaps source ${other.source}`);
      }
    }
  }
}

const EXPORT_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function parseExportRoots(raw: unknown, shareRoot: string, home: string): ExportRootConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('config: export_roots must be a list');
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) throw new Error(`config: export_roots[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    const account = asString(row.account, `export_roots[${index}].account`);
    if (!EXPORT_SLUG.test(account)) throw new Error(`config: export root ${account} account must be a lowercase slug`);
    if (seen.has(account)) throw new Error(`config: duplicate export root ${account}`);
    seen.add(account);
    const source = asString(row.source, `export_roots[${index}].source`);
    if (!EXPORT_SLUG.test(source)) throw new Error(`config: export root ${account} source must be a lowercase slug`);
    const path = resolve(expandShare(asString(row.path, `export_roots[${index}].path`), shareRoot, home));
    const targetRoot = resolve(expandShare(asString(row.target_root, `export_roots[${index}].target_root`), shareRoot, home));
    const base = basename(path);
    const placeholderBase = base === '_box-export-<ACCOUNT-B>';
    if (base !== '_box-export' && base !== `_box-export-${account}` && !placeholderBase) {
      throw new Error(`config: export root ${account} path must be named _box-export or _box-export-${account}`);
    }
    if (source === 'finance' || basename(targetRoot) === 'finance') {
      throw new Error(`config: export root ${account} cannot use the finance source`);
    }
    return {
      account,
      path,
      source,
      targetRoot,
      ensureSource: asBool(row.ensure_source, false),
    };
  });
}

function validateExportRoots(roots: ExportRootConfig[], groups: GroupConfig[], financeTargets: string[]): void {
  for (const root of roots) {
    if (isInside(root.path, root.targetRoot) || isInside(root.targetRoot, root.path)) {
      throw new Error(`config: export root ${root.account} path overlaps its target`);
    }
    if (financeTargets.some((target) => isInside(target, root.path) || isInside(root.path, target) || isInside(target, root.targetRoot) || isInside(root.targetRoot, target))) {
      throw new Error(`config: export root ${root.account} overlaps finance`);
    }
    for (const group of groups) {
      if (!group.failClosed || !group.stampRoot) continue;
      if (pathsAreSame(group.stampRoot, root.path) || isInside(group.stampRoot, root.path) || isInside(root.path, group.stampRoot)) {
        throw new Error(`config: export root ${root.account} overlaps a fail-closed stamp_root`);
      }
    }
  }
}
