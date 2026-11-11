import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { expandHome } from './files.ts';

export interface InputFolder {
  path: string;
  required: boolean;
  /** box-export inputs are still read when the stamp is stale; the run only warns. */
  role?: 'box-export';
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

function parseInputs(raw: unknown, shareRoot: string, home: string, botId: string): InputFolder[] {
  if (raw === undefined) return defaultInputs(shareRoot, botId);
  if (!Array.isArray(raw)) throw new Error(`config: bot ${botId} inputs must be a list`);
  return raw.map((item, index) => {
    const row = item as RawInput;
    const role = row.role === undefined ? undefined : asString(row.role, `inputs[${index}].role`);
    if (role !== undefined && role !== 'box-export') throw new Error(`config: unknown input role ${role}`);
    return {
      path: expandShare(asString(row.path, `bot ${botId} inputs[${index}].path`), shareRoot, home),
      required: asBool(row.required, false),
      ...(role === 'box-export' ? { role: 'box-export' as const } : {}),
    };
  });
}

function parseExtensions(raw: unknown, source: string): string[] {
  const base = source === 'finance' ? FINANCE_EXTENSIONS : PERSONAL_EXTENSIONS;
  if (raw === undefined) return base;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`config: extensions for source ${source} must be a non-empty list`);
  return raw.map((item, index) => {
    const ext = asString(item, `extensions[${index}]`).toLowerCase();
    if (!ext.startsWith('.')) throw new Error(`config: extension ${ext} must start with a dot`);
    return ext;
  });
}

export function loadConfig(path: string, home: string): LoaderConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const rawShare = asString(parsed.share_root, 'share_root');
  const shareRoot = resolve(expandHome(rawShare, home));
  const shareConfirmed = parsed.share_root_confirmed === true;
  const groupsRaw = parsed.groups;
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) throw new Error('config: groups must be a non-empty list');
  const groups: GroupConfig[] = groupsRaw.map((item, index) => {
    const group = item as RawGroup;
    const id = asString(group.id, `groups[${index}].id`);
    const source = asString(group.source, `groups[${index}].source`);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) {
      throw new Error(`config: group ${id} source ${source} must be a lowercase slug`);
    }
    const targetRoot = resolve(expandShare(asString(group.target_root, `group ${id} target_root`), shareRoot, home));
    const botsRaw = group.bots;
    if (!Array.isArray(botsRaw)) throw new Error(`config: group ${id} bots must be a list`);
    const bots: BotConfig[] = botsRaw.map((botItem, botIndex) => {
      const bot = botItem as RawBot;
      const botId = asString(bot.id, `group ${id} bots[${botIndex}].id`);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(botId)) throw new Error(`config: bot id ${botId} must be a lowercase slug`);
      return { id: botId, inputs: parseInputs(bot.inputs, shareRoot, home, botId) };
    });
    const forbidGit = asBool(group.forbid_git, source === 'finance');
    return {
      id,
      source,
      targetRoot,
      extensions: parseExtensions(group.extensions, source),
      ensureSource: asBool(group.ensure_source, source === 'finance'),
      forbidGit,
      bots,
    };
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
  assertRoutes(groups);
  const placeholderBot = groups.flatMap((group) => group.bots).find((bot) => PLACEHOLDER_BOTS.has(bot.id));
  const exampleShare = !shareConfirmed && (rawShare === EXAMPLE_SHARE || shareRoot === resolve(join(home, 'mnt/netfs')));
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
    boxExportDir: resolve(expandShare(typeof parsed.box_export_dir === 'string' ? parsed.box_export_dir : '<share>/personalgrok/gbrain/_box-export', shareRoot, home)),
    placeholder,
    groups,
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
