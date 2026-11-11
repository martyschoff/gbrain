import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync, chmodSync } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';

export function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value;
}

export function writeAtomic(path: string, data: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, mode);
}

export function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const child = resolve(target);
  return child === base || child.startsWith(base.endsWith(sep) ? base : base + sep);
}

export function toPosix(relative: string): string {
  return relative.split(sep).join('/');
}
