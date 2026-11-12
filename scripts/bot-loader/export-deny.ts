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

interface DenyFile {
  names: PatternRow[];
  content: PatternRow[];
  mail_headers?: string[];
  mail_min_headers?: number;
  mail_scan_lines?: number;
}

const patternPath = join(dirname(fileURLToPath(import.meta.url)), 'export-deny.json');
const patternFile = JSON.parse(readFileSync(patternPath, 'utf8')) as DenyFile;

function compile(rows: PatternRow[]): RegExp[] {
  return rows.map((row) => new RegExp(row.source, row.flags));
}

const DENY_NAMES = compile(patternFile.names);
const DENY_CONTENT = compile(patternFile.content);
const MAIL_HEADERS = patternFile.mail_headers ?? [];
const MAIL_MIN = patternFile.mail_min_headers ?? 2;
const MAIL_SCAN = patternFile.mail_scan_lines ?? 20;
const MAIL_LINE = MAIL_HEADERS.length === 0
  ? null
  : new RegExp(`^(?:${MAIL_HEADERS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}):[ \\t]+\\S`, 'i');

/** Several RFC 822 header lines near the top of a note, with or without an address. */
export function looksLikeMail(text: string): boolean {
  if (!MAIL_LINE) return false;
  let count = 0;
  for (const line of text.split(/\r?\n/).slice(0, MAIL_SCAN)) {
    if (MAIL_LINE.test(line)) count += 1;
  }
  return count >= MAIL_MIN;
}

export function deniedExportName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return DENY_NAMES.some((pattern) => pattern.test(base));
}

export function deniedExportContent(text: string): boolean {
  return looksLikeMail(text) || DENY_CONTENT.some((pattern) => pattern.test(text));
}
