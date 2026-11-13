/**
 * Compile a pattern from secret-patterns.json or export-deny.json the way
 * Python 3's `re` treats digits. The pattern text stays as it is in the JSON.
 *
 * With or without the `u` flag, JavaScript `\d` is ASCII `[0-9]` and `\b` is
 * an ASCII word boundary, so a fullwidth digit never matches `\d` and never
 * sits on `\b`. Python's `\d` is Unicode `Nd` and its `\b` treats those digits
 * as word characters. Translate `\d` / `\D` to `\p{Nd}` / `\P{Nd}`, and `\b` /
 * `\B` outside a class to a Unicode word boundary. Inside a class, `\b` stays
 * a backspace and `\-` becomes `\x2d`, because the `u` flag rejects that
 * identity escape.
 */

const WORD = String.raw`[\p{L}\p{N}_]`;
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const NON_BOUNDARY = `(?:(?<=${WORD})(?=${WORD})|(?<!${WORD})(?!${WORD}))`;

export function unicodePattern(source: string): string {
  let out = '';
  let inClass = false;
  let classStart = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[i + 1]!;
      i += 1;
      if (next === 'd') out += String.raw`\p{Nd}`;
      else if (next === 'D') out += String.raw`\P{Nd}`;
      else if (!inClass && next === 'b') out += BOUNDARY;
      else if (!inClass && next === 'B') out += NON_BOUNDARY;
      else if (inClass && next === '-') out += String.raw`\x2d`;
      else out += `\\${next}`;
      classStart = false;
      continue;
    }
    if (!inClass && ch === '[') {
      inClass = true;
      classStart = true;
      out += ch;
      continue;
    }
    if (inClass && ch === ']' && !classStart) {
      inClass = false;
      out += ch;
      continue;
    }
    if (inClass && classStart && ch === '^') {
      out += ch;
      continue;
    }
    out += ch;
    classStart = false;
  }
  return out;
}

export function compilePattern(source: string, flags: string): RegExp {
  const withUnicode = flags.includes('u') ? flags : `${flags}u`;
  return new RegExp(unicodePattern(source), withUnicode);
}

/** A fresh global copy. `pattern.source` is already translated, so this does not translate again. */
export function globalCopy(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}
