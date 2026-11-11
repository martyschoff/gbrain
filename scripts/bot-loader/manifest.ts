import { existsSync, readFileSync } from 'node:fs';
import { writeAtomic } from './files.ts';

export interface ManifestEntry {
  sha256: string;
  bot: string;
  source: string;
  slug: string;
  output: string;
  originRelpath: string;
  inBrain: boolean;
}

export interface Manifest {
  version: 1;
  files: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { version: 1, files: {} };
}

export function readManifest(path: string): Manifest {
  if (!existsSync(path)) return emptyManifest();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Manifest>;
  if (parsed.version !== 1 || typeof parsed.files !== 'object' || parsed.files === null) return emptyManifest();
  return { version: 1, files: parsed.files };
}

export function writeManifest(path: string, manifest: Manifest): void {
  writeAtomic(path, JSON.stringify(manifest, null, 2) + '\n', 0o600);
}
