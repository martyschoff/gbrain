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
  mail_address_headers?: string[];
  mail_other_headers?: string[];
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
const MAIL_MIN = patternFile.mail_min_headers ?? 2;
const MAIL_SCAN = patternFile.mail_scan_lines ?? 20;

function headerLine(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const body = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:${body}):[ \\t]+\\S`, 'i');
}

const ADDRESS_LINE = headerLine(patternFile.mail_address_headers ?? []);
const OTHER_LINE = headerLine(patternFile.mail_other_headers ?? []);

function withoutFrontMatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return text;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]!.trim() === '---') return lines.slice(i + 1).join('\n');
  }
  return text;
}

/** An address header plus another mail header, after a leading YAML block. */
export function looksLikeMail(text: string): boolean {
  if (!ADDRESS_LINE) return false;
  let address = 0;
  let other = 0;
  for (const line of withoutFrontMatter(text).split(/\r?\n/).slice(0, MAIL_SCAN)) {
    if (ADDRESS_LINE.test(line)) address += 1;
    else if (OTHER_LINE?.test(line)) other += 1;
  }
  return address >= 1 && address + other >= MAIL_MIN;
}

export function deniedExportName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return DENY_NAMES.some((pattern) => pattern.test(base));
}

export function deniedExportContent(text: string): boolean {
  return looksLikeMail(text) || DENY_CONTENT.some((pattern) => pattern.test(text));
}
