import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { contentHasSecret, isSecretFileName } from './secrets.ts';
import { toPosix } from './files.ts';

/** Always skipped, even when a group allowlist names them. */
const DENY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.heic', '.bmp', '.tif', '.tiff',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin',
  '.db', '.sqlite', '.sqlite3',
]);

const DENY_DIR_NAMES = new Set(['audit', 'audits', 'audit-logs', 'audit_logs', 'automations', '.git', 'node_modules']);

export interface ScannedFile {
  absolute: string;
  /** Posix path relative to the input root. */
  relativePosix: string;
  bytes: Buffer;
}

export interface ScanCounts {
  scanned: number;
  skipped: number;
  secrets: number;
}

export interface ScanResult {
  files: ScannedFile[];
  counts: ScanCounts;
}

function deniedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('.db-wal') || lower.endsWith('.db-shm')) return true;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && DENY_EXTENSIONS.has(lower.slice(dot))) return true;
  return false;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function scanTree(root: string, allow: ReadonlySet<string>, maxBytes: number): ScanResult {
  const files: ScannedFile[] = [];
  const counts: ScanCounts = { scanned: 0, skipped: 0, secrets: 0 };

  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      let info;
      try { info = lstatSync(absolute); } catch { counts.skipped++; continue; }
      if (info.isSymbolicLink()) { counts.skipped++; continue; }
      if (info.isDirectory()) {
        if (entry.name.startsWith('.') || DENY_DIR_NAMES.has(entry.name.toLowerCase())) continue;
        walk(absolute);
        continue;
      }
      if (!info.isFile()) { counts.skipped++; continue; }
      counts.scanned++;
      if (isSecretFileName(entry.name)) { counts.secrets++; continue; }
      const ext = extensionOf(entry.name);
      if (!allow.has(ext) || deniedName(entry.name)) { counts.skipped++; continue; }
      if (info.size > maxBytes) { counts.skipped++; continue; }
      const bytes = readFileSync(absolute);
      if (bytes.includes(0)) { counts.skipped++; continue; }
      if (contentHasSecret(bytes.toString('utf8'))) { counts.secrets++; continue; }
      const relativePosix = toPosix(relative(root, absolute)).split(sep).join('/');
      files.push({ absolute, relativePosix, bytes });
    }
  };

  walk(root);
  return { files, counts };
}
