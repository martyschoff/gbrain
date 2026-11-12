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
const SECRET_CONTENT = compile(patternFile.content);
const KEY_VALUE = /\b(?:api[_-]?key|access[_-]?token)\s*[=:]\s*(\S+)/i;

export function isSecretFileName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  return SECRET_NAMES.some((pattern) => pattern.test(base));
}

export function contentHasSecret(text: string): boolean {
  return SECRET_CONTENT.some((pattern) => {
    const match = pattern.exec(text);
    if (!match) return false;
    const key = KEY_VALUE.exec(text.slice(match.index));
    return !(key && placeholderSecret(key[1] ?? ''));
  });
}

/** Strip secret-shaped substrings before anything is written to a log. Never used on a page body. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_CONTENT) {
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[redacted]');
  }
  return out;
}
