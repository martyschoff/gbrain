/**
 * Extra filename and content denials for the multi-account drop.
 * Token and key rules stay in secret-patterns.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PatternRow {
  source: string;
  flags: string;
}

const patternPath = join(dirname(fileURLToPath(import.meta.url)), 'export-deny.json');
const patternFile = JSON.parse(readFileSync(patternPath, 'utf8')) as { names: PatternRow[]; content: PatternRow[] };

function compile(rows: PatternRow[]): RegExp[] {
  return rows.map((row) => new RegExp(row.source, row.flags));
}

const DENY_NAMES = compile(patternFile.names);
const DENY_CONTENT = compile(patternFile.content);

export function deniedExportName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return DENY_NAMES.some((pattern) => pattern.test(base));
}

export function deniedExportContent(text: string): boolean {
  return DENY_CONTENT.some((pattern) => pattern.test(text));
}
