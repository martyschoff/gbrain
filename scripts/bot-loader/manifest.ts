import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './files.ts';

export interface ManifestEntry {
  sha256: string;
  bot: string;
  source: string;
  slug: string;
  output: string;
  originRelpath: string;
  /** True only after put exits 0. Pending and failed puts stay false and are not counted. */
  inBrain: boolean;
  /** Put exited 10. The next run retries it. It is not a failure. */
  pending?: boolean;
  /** How many times this unchanged page has come back pending. */
  pendingAttempts?: number;
}

export interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
  /** Sources this loader has already registered. */
  sources?: Record<string, { added: true }>;
}

export function emptyManifest(): Manifest {
  return { version: 1, files: {} };
}

export function readManifest(path: string): Manifest {
  if (!existsSync(path)) return emptyManifest();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return emptyManifest();
  const sources = parsed.sources && typeof parsed.sources === 'object' ? parsed.sources : undefined;
  return { version: 1, files: parsed.files, ...(sources ? { sources } : {}) };
}

export function writeManifest(path: string, manifest: Manifest): void {
  writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n', 0o600);
}
