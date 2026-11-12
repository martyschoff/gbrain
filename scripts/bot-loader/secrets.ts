/**
 * Secret skips. The patterns live in secret-patterns.json, which
 * scripts/bot-loader/secret_rules.py loads for the box-export helper.
 * A match skips the whole file. Callers log counts only.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { placeholderSecret } from './export-deny.ts';

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

const patternPath = join(dirname(fileURLToPath(import.meta.url)), 'secret-patterns.json');
const patternFile = JSON.parse(readFileSync(patternPath, 'utf8')) as SecretPatternFile;

function compile(rows: PatternRow[]): RegExp[] {
  return rows.map((row) => new RegExp(row.source, row.flags));
}

const SECRET_NAMES = compile(patternFile.names);
const REDACT_CONTENT = compile(patternFile.content);
const SECRET_CONTENT = compile(patternFile.content.filter((row) => !row.allow_placeholders));
const PLACEHOLDER_KEYS = patternFile.content.filter((row) => row.allow_placeholders);

function assignmentIsSecret(text: string, source: string, flags: string): boolean {
  const pattern = new RegExp(source, flags.includes('g') ? flags : `${flags}g`);
  for (const match of text.matchAll(pattern)) {
    const bare = (match[1] ?? '').trim();
    const value = bare.length >= 2 && ((bare.startsWith('"') && bare.endsWith('"')) || (bare.startsWith("'") && bare.endsWith("'")))
      ? bare.slice(1, -1)
      : bare;
    if (value.length > 0 && !placeholderSecret(value)) return true;
  }
  return false;
}

export function isSecretFileName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return SECRET_NAMES.some((pattern) => pattern.test(base));
}

export function contentHasSecret(text: string): boolean {
  if (SECRET_CONTENT.some((pattern) => pattern.test(text))) return true;
  return PLACEHOLDER_KEYS.some((row) => assignmentIsSecret(text, row.source, row.flags));
}

/** Strip secret-shaped substrings before anything is written to a log. Never used on a page body. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of REDACT_CONTENT) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]');
  }
  return out;
}
