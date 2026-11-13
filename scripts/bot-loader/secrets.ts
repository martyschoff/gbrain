/**
 * Secret skips. The patterns live in secret-patterns.json, which
 * scripts/bot-loader/secret_rules.py loads for the box-export helper.
 * A match skips the whole file. Rule labels name the row, never the value.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholderSecret } from './export-deny.ts';
import { compilePattern, globalCopy } from './unicode-regexp.ts';

interface PatternRow {
  source: string;
  flags: string;
  sample: string;
  allow_placeholders?: boolean;
}

interface SecretPatternFile {
  description: string;
  names: PatternRow[];
  content: PatternRow[];
  name_negatives: string[];
  content_negatives: string[];
}

export interface RuleMatch {
  rule: string;
  /** 1-based line of the first match in the scanned text. */
  line: number;
  index: number;
  length: number;
}

const patternPath = join(dirname(fileURLToPath(import.meta.url)), 'secret-patterns.json');
const patternFile = JSON.parse(readFileSync(patternPath, 'utf8')) as SecretPatternFile;

interface Compiled {
  index: number;
  source: string;
  flags: string;
  pattern: RegExp;
  allowPlaceholders: boolean;
}

function compile(rows: PatternRow[]): Compiled[] {
  return rows.map((row, index) => ({
    index,
    source: row.source,
    flags: row.flags,
    pattern: compilePattern(row.source, row.flags),
    allowPlaceholders: row.allow_placeholders === true,
  }));
}

const NAMES = compile(patternFile.names);
const CONTENT = compile(patternFile.content);
const REDACT_CONTENT = CONTENT.map((row) => row.pattern);

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  const end = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < end; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Patterns anchored with `(?:^|[\\n,])` include the newline in the match. The line is the key, not that newline. */
function lineOfMatch(text: string, index: number, lexeme: string): number {
  let start = index;
  if (lexeme.startsWith('\r\n')) start += 2;
  else if (lexeme.startsWith('\n')) start += 1;
  return lineNumberAt(text, start);
}

function baseName(name: string): string {
  return name.split(/[/\\]/).pop() ?? name;
}

/** First filename rule, or null. `secrets.names[N]` uses the JSON row index. */
export function secretNameRule(part: string): string | null {
  const base = baseName(part);
  for (const row of NAMES) {
    if (row.pattern.test(base)) return `secrets.names[${row.index}]`;
  }
  return null;
}

export function isSecretFileName(name: string): boolean {
  return secretNameRule(name) !== null;
}

function assignmentMatch(text: string, source: string, flags: string): { index: number; length: number } | null {
  const pattern = compilePattern(source, flags.includes('g') ? flags : `${flags}g`);
  for (const match of text.matchAll(pattern)) {
    const bare = (match[1] ?? '').trim();
    const value = bare.length >= 2 && ((bare.startsWith('"') && bare.endsWith('"')) || (bare.startsWith("'") && bare.endsWith("'")))
      ? bare.slice(1, -1)
      : bare;
    if (value.length > 0 && !placeholderSecret(value) && match.index !== undefined) {
      const lexeme = match[0];
      const index = lexeme.startsWith('\n') ? match.index + 1 : match.index;
      return { index, length: lexeme.length - (index - match.index) };
    }
  }
  return null;
}

/** First content rule, or null. Placeholder key rows use `secrets.key_assignment`. */
export function secretContentMatch(text: string): RuleMatch | null {
  for (const row of CONTENT) {
    if (row.allowPlaceholders) continue;
    const match = row.pattern.exec(text);
    if (match && match.index !== undefined) {
      return {
        rule: `secrets.content[${row.index}]`,
        line: lineOfMatch(text, match.index, match[0]),
        index: match.index,
        length: match[0].length,
      };
    }
  }
  for (const row of CONTENT) {
    if (!row.allowPlaceholders) continue;
    const hit = assignmentMatch(text, row.source, row.flags);
    if (hit) {
      return { rule: 'secrets.key_assignment', line: lineNumberAt(text, hit.index), index: hit.index, length: hit.length };
    }
  }
  return null;
}

export function secretContentRule(text: string): string | null {
  return secretContentMatch(text)?.rule ?? null;
}

export function contentHasSecret(text: string): boolean {
  return secretContentRule(text) !== null;
}

/** Strip secret-shaped substrings before anything is written to a log. Never used on a page body. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of REDACT_CONTENT) {
    out = out.replace(globalCopy(pattern), '[redacted]');
  }
  return out;
}
