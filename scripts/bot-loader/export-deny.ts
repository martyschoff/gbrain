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

interface KeyAssignment {
  source: string;
  flags: string;
  min_length?: number;
}

interface DenyFile {
  names: PatternRow[];
  content: PatternRow[];
  key_assignment?: KeyAssignment;
  mail_headers?: string[];
  mail_address_headers?: string[];
  mail_strong_headers?: string[];
  mail_block_headers?: string[];
  mail_block_min?: number;
  mail_markers?: PatternRow[];
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
const KEY_ASSIGNMENT = patternFile.key_assignment
  ? new RegExp(patternFile.key_assignment.source, `${patternFile.key_assignment.flags}g`)
  : null;
const KEY_MIN = patternFile.key_assignment?.min_length ?? 8;
const MAIL_HEADERS = patternFile.mail_headers ?? [];
const ADDRESS_HEADERS = new Set((patternFile.mail_address_headers ?? []).map((name) => name.toLowerCase()));
const STRONG_HEADERS = new Set((patternFile.mail_strong_headers ?? []).map((name) => name.toLowerCase()));
const BLOCK_HEADERS = new Set((patternFile.mail_block_headers ?? []).map((name) => name.toLowerCase()));
const BLOCK_MIN = patternFile.mail_block_min ?? 3;
const MAIL_MARKERS = compile(patternFile.mail_markers ?? []);
const MAIL_MIN = patternFile.mail_min_headers ?? 2;
const MAIL_SCAN = patternFile.mail_scan_lines ?? 20;

function escapeHeader(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAIL_LINE = MAIL_HEADERS.length === 0
  ? null
  : new RegExp(`^(${MAIL_HEADERS.map(escapeHeader).join('|')}):[ \\t]+(\\S.*)$`, 'i');
const ADDRESS_VALUE = /<[^\s<>]*@[^\s<>]*>|[^\s<>@]+@[^\s<>@]+/;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** ALL_CAPS words, angle placeholders, and handbook tokens are not keys. */
export function placeholderSecret(value: string): boolean {
  const bare = unquote(value);
  if (bare.startsWith('<') && bare.endsWith('>') && bare.length >= 2) return true;
  if (/^x{3,}$/i.test(bare)) return true;
  if (/^(?:SEE_|EXAMPLE|YOUR_)/i.test(bare)) return true;
  if (/^[A-Z][A-Z0-9_]{7,}$/.test(bare)) return true;
  return false;
}

function deniedKeyAssignment(text: string): boolean {
  if (!KEY_ASSIGNMENT) return false;
  KEY_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(KEY_ASSIGNMENT)) {
    const bare = unquote(match[1] ?? '');
    if (bare.length >= KEY_MIN && !placeholderSecret(bare)) return true;
  }
  return false;
}

/**
 * An address on From/To/Cc/Bcc/Reply-To/Return-Path, a Message-ID or Received
 * header, three header lines in a row, or a forward/quote marker.
 * Only a leading closed --- block is YAML and is ignored.
 */
export function looksLikeMail(text: string): boolean {
  if (!MAIL_LINE) return false;
  const lines = text.split(/\r?\n/);
  let start = 0;
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]!.trim() === '---') {
        start = i + 1;
        break;
      }
    }
  }
  const window = lines.slice(start, start + MAIL_SCAN);
  if (window.some((line) => MAIL_MARKERS.some((pattern) => pattern.test(line)))) return true;
  let headers = 0;
  let address = false;
  let strong = false;
  let run = 0;
  let blockStarted = false;
  for (const line of window) {
    if (!blockStarted && line.trim() === '') continue;
    const match = MAIL_LINE.exec(line);
    if (!blockStarted) {
      blockStarted = true;
    }
    if (match && BLOCK_HEADERS.has((match[1] ?? '').toLowerCase()) && run >= 0) {
      run += 1;
      if (run >= BLOCK_MIN) return true;
    } else if (blockStarted && line.trim() !== '') {
      run = -1;
    }
    if (!match) continue;
    headers += 1;
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    if (STRONG_HEADERS.has(name)) strong = true;
    if (ADDRESS_HEADERS.has(name) && ADDRESS_VALUE.test(value)) address = true;
  }
  return headers >= MAIL_MIN && (address || strong);
}

export function deniedExportName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return DENY_NAMES.some((pattern) => pattern.test(base));
}

export function deniedExportContent(text: string): boolean {
  return looksLikeMail(text) || deniedKeyAssignment(text) || DENY_CONTENT.some((pattern) => pattern.test(text));
}
