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
  mail_min_headers?: number;
  mail_block_min?: number;
  mail_scan_lines?: number;
  mail_markers?: PatternRow[];
}

const patternPath = join(dirname(fileURLToPath(import.meta.url)), 'export-deny.json');
const patternFile = JSON.parse(readFileSync(patternPath, 'utf8')) as DenyFile;

interface Compiled {
  index: number;
  pattern: RegExp;
}

function compileIndexed(rows: PatternRow[]): Compiled[] {
  return rows.map((row, index) => ({ index, pattern: new RegExp(row.source, row.flags) }));
}

const DENY_NAME_ROWS = compileIndexed(patternFile.names);
const DENY_CONTENT_ROWS = compileIndexed(patternFile.content);
const MAIL_MARKER_ROWS = compileIndexed(patternFile.mail_markers ?? []);
const KEY_ASSIGNMENT = patternFile.key_assignment
  ? new RegExp(patternFile.key_assignment.source, `${patternFile.key_assignment.flags}g`)
  : null;
const KEY_MIN = patternFile.key_assignment?.min_length ?? 8;
const MAIL_HEADERS = patternFile.mail_headers ?? [];
const ADDRESS_HEADERS = new Set((patternFile.mail_address_headers ?? []).map((name) => name.toLowerCase()));
const STRONG_HEADERS = new Set((patternFile.mail_strong_headers ?? []).map((name) => name.toLowerCase()));
const BLOCK_HEADERS = patternFile.mail_block_headers ?? [];
const MAIL_MIN = patternFile.mail_min_headers ?? 2;
const BLOCK_MIN = patternFile.mail_block_min ?? 3;
const MAIL_SCAN = patternFile.mail_scan_lines ?? 20;
export interface RuleMatch {
  rule: string;
  /** 1-based line of the first match in the scanned text. */
  line: number;
  index: number;
  length: number;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function lineOfMatch(text: string, index: number, lexeme: string): number {
  let start = index;
  if (lexeme.startsWith('\r\n')) start += 2;
  else if (lexeme.startsWith('\n')) start += 1;
  return lineNumberAt(text, start);
}

function escapeHeader(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAIL_LINE = MAIL_HEADERS.length === 0
  ? null
  : new RegExp(`^(${MAIL_HEADERS.map(escapeHeader).join('|')}):[ \\t]+(\\S.*)$`, 'i');
const BLOCK_LINE = BLOCK_HEADERS.length === 0
  ? null
  : new RegExp(`^[ \\t]*(?:>[ \\t]*)?(?:${BLOCK_HEADERS.map(escapeHeader).join('|')}):[ \\t]+\\S`, 'i');
const STRONG_LINE = STRONG_HEADERS.size === 0
  ? null
  : new RegExp(`^(?:${[...STRONG_HEADERS].map(escapeHeader).join('|')}):[ \\t]+\\S`, 'i');
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

function deniedKeyMatch(text: string): { index: number; length: number } | null {
  if (!KEY_ASSIGNMENT) return null;
  KEY_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(KEY_ASSIGNMENT)) {
    const bare = unquote(match[1] ?? '');
    if (bare.length >= KEY_MIN && !placeholderSecret(bare) && match.index !== undefined) {
      return { index: match.index, length: match[0].length };
    }
  }
  return null;
}

/**
 * Lines of a leading closed front-matter block are not headers.
 * The block counts only when the first line is `---` and a later line closes it.
 * An unclosed `---` is ordinary text. Message-ID and Received stay visible
 * even inside that closed block. Nothing else between fences is skipped.
 */
interface MailLine {
  text: string;
  line: number;
}

function mailWindow(text: string): MailLine[] {
  const lines = text.split(/\r?\n/);
  let close = -1;
  if ((lines[0] ?? '').trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if ((lines[i] ?? '').trim() === '---') {
        close = i;
        break;
      }
    }
  }
  const visible: MailLine[] = [];
  for (let i = 0; i < lines.length && visible.length < MAIL_SCAN; i += 1) {
    const inside = close > 0 && i > 0 && i < close;
    if (inside && !(STRONG_LINE && STRONG_LINE.test(lines[i] ?? ''))) continue;
    if (close > 0 && (i === 0 || i === close)) continue;
    visible.push({ text: lines[i] ?? '', line: i + 1 });
  }
  return visible;
}

function headerCandidate(line: string): string {
  return line.trim().replace(/^(?:>\s*)+/, '');
}

/**
 * Mail is an address on From/To/Cc/Bcc/Reply-To/Return-Path, a Message-ID
 * or Received header, three contiguous header lines anywhere in the scan
 * window, or a forward/reply marker. Only a leading closed YAML block is ignored.
 */
function headerMail(lines: MailLine[]): RuleMatch | null {
  if (!MAIL_LINE) return null;
  let headers = 0;
  let address = false;
  let strong = false;
  let first: MailLine | null = null;
  for (const line of lines) {
    const match = MAIL_LINE.exec(line.text);
    if (!match) continue;
    headers += 1;
    if (!first) first = line;
    const name = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    if (STRONG_HEADERS.has(name)) strong = true;
    if (ADDRESS_HEADERS.has(name) && ADDRESS_VALUE.test(value)) address = true;
  }
  if (!(headers >= MAIL_MIN && (address || strong)) || !first) return null;
  return { rule: 'deny.mail_headers', line: first.line, index: 0, length: 0 };
}

function blockMail(lines: MailLine[]): RuleMatch | null {
  if (!BLOCK_LINE) return null;
  let run = 0;
  let start: MailLine | null = null;
  for (const line of lines) {
    const candidate = headerCandidate(line.text);
    if (BLOCK_LINE.test(candidate)) {
      run += 1;
      if (!start) start = line;
      if (run >= BLOCK_MIN && start) {
        return { rule: 'deny.mail_headers', line: start.line, index: 0, length: 0 };
      }
      continue;
    }
    run = 0;
    start = null;
  }
  return null;
}

/** First mail rule, or null. Markers keep their row index; header blocks use `deny.mail_headers`. */
function mailRule(text: string): RuleMatch | null {
  if (!MAIL_LINE) return null;
  const lines = mailWindow(text);
  for (const row of MAIL_MARKER_ROWS) {
    for (const line of lines) {
      if (!row.pattern.test(line.text)) continue;
      return { rule: `deny.mail_markers[${row.index}]`, line: line.line, index: 0, length: 0 };
    }
  }
  return blockMail(lines) ?? headerMail(lines);
}

export function looksLikeMail(text: string): boolean {
  return mailRule(text) !== null;
}

/** First filename rule, or null. `deny.names[N]` uses the JSON row index. */
export function deniedNameRule(name: string): string | null {
  const base = name.split(/[/\\]/).pop() ?? name;
  for (const row of DENY_NAME_ROWS) {
    if (row.pattern.test(base)) return `deny.names[${row.index}]`;
  }
  return null;
}

export function deniedExportName(name: string): boolean {
  return deniedNameRule(name) !== null;
}

/** First content rule, or null. Key rows use `deny.key_assignment`. */
export function deniedContentMatch(text: string): RuleMatch | null {
  const mail = mailRule(text);
  if (mail) return mail;
  const key = deniedKeyMatch(text);
  if (key) return { rule: 'deny.key_assignment', line: lineOfMatch(text, key.index, text.slice(key.index, key.index + key.length)), index: key.index, length: key.length };
  for (const row of DENY_CONTENT_ROWS) {
    const match = row.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    return {
      rule: `deny.content[${row.index}]`,
      line: lineOfMatch(text, match.index, match[0]),
      index: match.index,
      length: match[0].length,
    };
  }
  return null;
}

export function deniedContentRule(text: string): string | null {
  return deniedContentMatch(text)?.rule ?? null;
}

export function deniedExportContent(text: string): boolean {
  return deniedContentRule(text) !== null;
}
