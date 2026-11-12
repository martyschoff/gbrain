import { createHash } from 'node:crypto';
import { slugFromRelative } from './slug.ts';

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n') && !markdown.startsWith('---\r\n')) return markdown;
  const end = markdown.search(/\r?\n---\r?\n/);
  if (end < 0) return markdown;
  const after = markdown.slice(end).replace(/^\r?\n---\r?\n/, '');
  return after;
}

export interface CsvRender {
  body: string;
  truncated: boolean;
}

/** Minimal CSV (quotes and commas). The first row is the header. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.length > 0)) rows.push(row);
  }
  return rows;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function csvToMarkdown(text: string, maxDataRows: number): CsvRender {
  const rows = parseCsv(text);
  if (rows.length === 0) return { body: '_Empty table._\n', truncated: false };
  const header = rows[0] ?? [];
  const data = rows.slice(1);
  const kept = data.slice(0, maxDataRows);
  const truncated = data.length > maxDataRows;
  const lines = [
    `| ${header.map(escapeCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...kept.map((cells) => `| ${header.map((_, index) => escapeCell(cells[index] ?? '')).join(' | ')} |`),
  ];
  if (truncated) lines.push('', `_Truncated after ${maxDataRows} data rows._`);
  return { body: lines.join('\n') + '\n', truncated };
}

export interface PageInput {
  /** Posix path under the bot directory, ending in `.md`. */
  relativeMd: string;
  title: string;
  originRelpath: string;
  originSha256: string;
  body: string;
  /** Set for a multi-account drop so the page is tagged with its account and bot. */
  account?: string;
  bot?: string;
  botName?: string;
}

export function pageSlug(relativeMd: string): string {
  return slugFromRelative(relativeMd);
}

export function renderPage(input: PageInput): string {
  const slug = pageSlug(input.relativeMd);
  const body = input.body.endsWith('\n') ? input.body : `${input.body}\n`;
  const lines = [
    '---',
    `slug: ${slug}`,
    'type: note',
    `title: ${yamlString(input.title)}`,
  ];
  if (input.account) lines.push(`account: ${yamlString(input.account)}`);
  if (input.bot) lines.push(`bot: ${yamlString(input.bot)}`);
  if (input.botName) lines.push(`bot_name: ${yamlString(input.botName)}`);
  lines.push(
    `origin_relpath: ${yamlString(input.originRelpath)}`,
    `origin_sha256: ${yamlString(input.originSha256)}`,
    '---',
    '',
    body,
  );
  return lines.join('\n');
}

export function bodyForExtension(ext: string, raw: string, csvMaxRows: number): string {
  const lower = ext.toLowerCase();
  if (lower === '.md' || lower === '.markdown') return stripFrontmatter(raw);
  if (lower === '.csv') return csvToMarkdown(raw, csvMaxRows).body;
  if (lower === '.json') {
    let pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep the bytes as text */ }
    return '```json\n' + pretty.replace(/\s*$/, '') + '\n```\n';
  }
  if (lower === '.yaml' || lower === '.yml') return '```yaml\n' + raw.replace(/\s*$/, '') + '\n```\n';
  if (lower === '.txt') return raw.endsWith('\n') ? raw : `${raw}\n`;
  return '```\n' + raw.replace(/\s*$/, '') + '\n```\n';
}
