import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../scripts/bot-loader/config.ts';
import { deniedContentMatch, deniedContentRule, deniedExportContent, deniedExportName, deniedNameRule, redactExportDenyContent } from '../scripts/bot-loader/export-deny.ts';
import { contentHasSecret, isSecretFileName, secretContentMatch, secretContentRule, secretNameRule } from '../scripts/bot-loader/secrets.ts';
import type { BrainClient } from '../scripts/bot-loader/gbrain-client.ts';
import { isNewYorkExportTime } from '../scripts/bot-loader/multi-account.ts';
import { sha256 } from '../scripts/bot-loader/render.ts';
import { runLoader } from '../scripts/bot-loader/run.ts';
import type { LoaderConfig } from '../scripts/bot-loader/config.ts';

const REPO = join(import.meta.dir, '..');
const BOX = join(REPO, 'scripts/bot-loader/box-export.py');
const STAMP = '2026-11-12T02:00:00-05:00';

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

function fakeBrain(): { brain: BrainClient; puts: { source: string; slug: string; file: string; text: string }[] } {
  const puts: { source: string; slug: string; file: string; text: string }[] = [];
  const brain: BrainClient = {
    async ensureSource() { return { ok: true }; },
    async putPage(source, slug, file) {
      puts.push({ source, slug, file, text: existsSync(file) ? readFileSync(file, 'utf8') : '' });
      return { ok: true, pending: false };
    },
    async counts() { return { sources: {}, bots: {}, via: 'pages written by the loader (manifest)' }; },
  };
  return { brain, puts };
}

function goodFiles(bot: string): Record<string, string> {
  return {
    'profile.json': `{"id":"${bot}","name":"Bot A"}\n`,
    'memory.md': '# Memory\n\n## 2026-11-12\n\nA fake fact.\n',
    'routines.md': '# Routines\n\n## morning\n\n- schedule: 0 2 * * *\n- prompt: Summarize the day.\n',
    'skills/daily.md': '# Daily\n\nSay hello.\n',
    'notes/scratch.md': 'A note.\n',
  };
}

function writeBot(dir: string, account: string, bot: string, files: Record<string, string>, patch?: (manifest: Record<string, unknown>) => void): void {
  const listed: Record<string, { size: number; sha256: string }> = {};
  for (const [rel, text] of Object.entries(files)) {
    write(join(dir, rel), text);
    const buf = Buffer.from(text);
    listed[rel] = { size: buf.length, sha256: sha256(buf) };
  }
  const manifest: Record<string, unknown> = {
    version: 1,
    bot_name: 'Bot A',
    bot_id: bot,
    account,
    exported_at: STAMP,
    files: listed,
  };
  patch?.(manifest);
  write(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
}

function configFor(home: string, share: string, roots: Record<string, unknown>[]): LoaderConfig {
  mkdirSync(join(share, 'empty-alpha'), { recursive: true });
  const path = join(home, 'config.json');
  writeFileSync(path, JSON.stringify({
    share_root: share,
    state_path: join(home, 'state.json'),
    summary_path: join(home, 'summary.txt'),
    lock_path: join(home, 'run.lock'),
    host_env: join(home, 'host.env'),
    gbrain_bin: '/usr/bin/gbrain',
    max_bytes: 100000,
    box_export_dir: join(share, 'unused-box'),
    groups: [{
      id: 'personal',
      source: 'personal',
      target_root: join(share, 'personal-pages'),
      ensure_source: false,
      forbid_git: false,
      bots: [{ id: 'alpha', inputs: [{ path: join(share, 'empty-alpha'), required: false }] }],
    }],
    export_roots: roots,
  }));
  writeFileSync(join(home, 'host.env'), 'GBRAIN_EXPECTED_HOST=test-host\n');
  return loadConfig(path, home);
}

function roots(share: string): Record<string, unknown>[] {
  return [
    { account: 'account-a', path: join(share, 'drops', '_box-export'), source: 'account-a', target_root: join(share, 'pages-a') },
    { account: 'account-b', path: join(share, 'drops', '_box-export-account-b'), source: 'account-b', target_root: join(share, 'pages-b') },
  ];
}

async function run(config: LoaderConfig, brain: BrainClient, exportRecheck?: (botDir: string) => void) {
  return runLoader({
    config,
    hostname: 'test-host',
    isMounted: () => true,
    brain,
    now: new Date('2026-11-12T12:00:00Z'),
    ...(exportRecheck ? { exportRecheck } : {}),
  });
}

describe('secret rule labels', () => {
  test('each family returns a stable label and line, and wrappers stay boolean', () => {
    const secretPatterns = JSON.parse(readFileSync(join(REPO, 'scripts/bot-loader/secret-patterns.json'), 'utf8')) as {
      names: { sample: string }[];
      content: { sample: string }[];
      name_negatives: string[];
      content_negatives: string[];
    };
    for (const row of secretPatterns.names) {
      expect(isSecretFileName(row.sample)).toBe(secretNameRule(row.sample) !== null);
      expect(secretNameRule(row.sample)).toMatch(/^secrets\.names\[\d+\]$/);
    }
    for (const name of secretPatterns.name_negatives) {
      expect(secretNameRule(name)).toBeNull();
      expect(isSecretFileName(name)).toBe(false);
    }
    for (const row of secretPatterns.content) {
      expect(contentHasSecret(row.sample)).toBe(secretContentRule(row.sample) !== null);
      const hit = secretContentMatch(row.sample);
      expect(hit?.rule === 'secrets.key_assignment' || /^secrets\.content\[\d+\]$/.test(hit?.rule ?? '')).toBe(true);
      expect(hit?.line).toBeGreaterThan(0);
    }
    for (const text of secretPatterns.content_negatives) {
      expect(secretContentRule(text)).toBeNull();
      expect(contentHasSecret(text)).toBe(false);
    }
    expect(secretNameRule('notes/api-token.txt')).toBe('secrets.names[9]');
    expect(secretContentMatch('note\n-----BEGIN OPENSSH PRIVATE KEY-----\n')).toEqual({
      rule: 'secrets.content[0]', line: 2, index: 5, length: '-----BEGIN OPENSSH PRIVATE KEY-----'.length,
    });
    expect(secretContentMatch('x\napi_key=' + 'not-a-real-value\n')?.rule).toBe('secrets.key_assignment');
    expect(secretContentMatch('x\napi_key=' + 'not-a-real-value\n')?.line).toBe(2);
    expect(deniedNameRule('holdings.csv')).toBe('deny.names[0]');
    expect(deniedExportName('holdings.csv')).toBe(deniedNameRule('holdings.csv') !== null);
    expect(deniedExportName('memory.md')).toBe(false);
    const email = deniedContentMatch('hello\n' + 'ada' + '@' + 'example.org' + '\n');
    expect(email?.rule).toBe('deny.content[0]');
    expect(email?.line).toBe(2);
    expect(deniedContentMatch('api_key=' + 'not-a-real-value')?.rule).toBe('deny.key_assignment');
    expect(deniedContentMatch('api_key=' + 'not-a-real-value')?.line).toBe(1);
    const mail = deniedContentMatch('From: ' + 'ada' + '@' + 'example.org' + '\nSubject: hello\n');
    expect(mail?.rule).toBe('deny.mail_headers');
    expect(mail?.line).toBe(1);
    expect(deniedExportContent('From: ' + 'ada' + '@' + 'example.org' + '\nSubject: hello\n')).toBe(deniedContentRule('From: ' + 'ada' + '@' + 'example.org' + '\nSubject: hello\n') !== null);
    expect(deniedContentRule('A fake fact.')).toBeNull();
    expect(deniedExportContent('A fake fact.')).toBe(false);
  });
});

describe('multi-account export time', () => {
  test('accepts an America/New_York stamp and rejects a Zulu or wrong offset', () => {
    expect(isNewYorkExportTime(STAMP)).toBe(true);
    expect(isNewYorkExportTime('2026-07-12T02:00:00-04:00')).toBe(true);
    expect(isNewYorkExportTime('2026-11-12T02:00:00Z')).toBe(false);
    expect(isNewYorkExportTime('2026-11-12T02:00:00-04:00')).toBe(false);
    expect(deniedExportName('holdings.csv')).toBe(true);
    expect(deniedExportName('memory.md')).toBe(false);
    expect(deniedExportContent('call ' + '555' + '-' + '010' + '-' + '0199')).toBe(true);
    expect(deniedExportContent('call ' + '555' + '.' + '010' + '.' + '0199')).toBe(true);
    expect(deniedExportContent('ssn ' + '000' + '-' + '00' + '-' + '0000')).toBe(true);
    expect(deniedExportContent('password: ' + 'not-a-real-value')).toBe(true);
    expect(deniedExportContent('password policy lives in the handbook')).toBe(false);
    expect(deniedExportContent('api_key=' + 'not-a-real-value')).toBe(true);
    expect(deniedExportContent('api_key=' + 'ab12cd34ef56gh78')).toBe(true);
    expect(deniedExportContent('api_key: SEE_HANDBOOK')).toBe(false);
    expect(deniedExportContent('```\napi_key: SEE_HANDBOOK\n```\n')).toBe(false);
    expect(deniedExportContent('api_key: YOUR_KEY_HERE')).toBe(false);
    expect(deniedExportContent('api_key: <EXAMPLE>\n')).toBe(false);
    expect(deniedExportName('brokerage.csv')).toBe(true);
    expect(deniedExportContent('The holdings list stays offline.')).toBe(true);
    expect(deniedExportContent('We talked about brokerage fees yesterday.')).toBe(false);
    expect(deniedExportContent('the tax-lot method is FIFO')).toBe(false);
    expect(deniedExportContent('9' + ' Example ' + 'Place')).toBe(true);
    expect(deniedExportContent('9 items in place.')).toBe(false);
    expect(deniedExportContent('call +1 ' + '555' + ' ' + '010' + ' ' + '0199')).toBe(true);
    expect(deniedExportContent('We are holding the meeting on Friday.')).toBe(false);
    expect(deniedExportContent('The api key is rotated quarterly.')).toBe(false);
    expect(deniedExportContent('From: ' + 'ada' + '@' + 'example.com' + '\nSubject: hello\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('To: <' + 'ada' + '@' + 'example.com' + '>\nDate: Thu, 12 Nov 2026 02:00:00 -0500\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('From: ada\nSubject: hello\n\nA note.\n')).toBe(false);
    expect(deniedExportContent('Invoice follow-up\nFrom: Ada Example\nSubject: Re: invoice\nDate: Tuesday\n')).toBe(true);
    expect(deniedExportContent('Invoice follow-up\n\nFrom: Ada Example\nSubject: Re: invoice\nDate: Tuesday\n')).toBe(true);
    expect(deniedExportContent('> From: Ada Example\n> Subject: Re: invoice\n> Date: Tuesday\n')).toBe(true);
    expect(deniedExportContent('  From: Ada Example\n  Subject: Re: invoice\n  Date: Tuesday\n')).toBe(true);
    expect(deniedExportContent('| From | To |\n| --- | --- |\n| Ada Example | Quinn Example |\n')).toBe(false);
    expect(deniedExportContent('From: Ada Example\nSubject: Re: invoice\nDate: Thursday\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('From: Ada Example\nSent: Thursday, November 12, 2026 2:00 AM\nTo: the team\nSubject: Re: invoice\n')).toBe(true);
    expect(deniedExportContent('-----Original Message-----\nA note.\n')).toBe(true);
    expect(deniedExportContent('---------- Forwarded message ---------\nA note.\n')).toBe(true);
    expect(deniedExportContent('On Thursday, 12 Nov 2026, Ada Example wrote:\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('From: the desk\nTo: the team\nSubject: Re: invoice\n')).toBe(true);
    expect(deniedExportContent('---\nReceived: by mail.example.test\nMessage-ID: <fake.1>\n---\nNotes about the plan.\n')).toBe(true);
    expect(deniedExportContent('---\nReceived: by mail.example.test\nMessage-ID: <fake.1>\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('Notes about the plan.\n---\nReceived: by mail.example.test\nMessage-ID: <fake.1>\n---\n')).toBe(true);
    expect(contentHasSecret('api_key=YOUR_KEY_HERE')).toBe(false);
    expect(contentHasSecret('api_key=' + 'xxxxxxxx')).toBe(false);
    expect(contentHasSecret('api_key=EXAMPLEabc123def456')).toBe(false);
    expect(contentHasSecret('api_key=ALLCAPSWITH123DIGITS')).toBe(false);
    expect(contentHasSecret('api_key=' + 'not-a-real-value')).toBe(true);
    expect(deniedExportContent('---\nfrom: the notes\ndate: Tuesday\n---\n\nThe plan is to walk the hill.\n')).toBe(false);
    expect(deniedExportContent('---\nfrom: Ada Example\nsubject: Re: invoice\ndate: Tuesday\n---\nWalk the hill.\n')).toBe(false);
    expect(deniedExportContent('Date: Tuesday\nSubject: tomorrow\'s plan\n')).toBe(false);
    expect(deniedExportContent('To: the point of the meeting\nDate: Tuesday\n')).toBe(false);
    expect(deniedExportContent('From: Ada Example\nSubject: Re: invoice\nDate: Tue, 12 Nov 2026 02:00:00 -0500\n\nA pasted note with no address.\n')).toBe(true);
    expect(deniedExportContent('From: Ada Example\nSent: Thursday, November 12, 2026 2:00 AM\nTo: Quinn Example\nSubject: Re: invoice\n')).toBe(true);
    expect(deniedExportContent('-----Original Message-----\nFrom: Ada Example\nSubject: Re: invoice\n\nPlease read the note.\n')).toBe(true);
    expect(deniedExportContent('---------- Forwarded message ---------\nFrom: Ada Example\nDate: Tuesday\nSubject: Re: invoice\n\nA note.\n')).toBe(true);
    expect(deniedExportContent('On Thu, 12 Nov 2026, Ada Example wrote:\nThe invoice is a story.\n')).toBe(true);
    expect(deniedExportContent('From: Pat Example\nTo: Quinn Example\nSubject: notes\nDate: Tuesday\n')).toBe(true);
    expect(deniedExportContent('---\ntitle: note\nReceived: by mail.example.test\nMessage-ID: <fake.1>\n---\nA note.\n')).toBe(true);
    expect(deniedExportContent('---\ntitle: note\nReceived: by mail.example.test\nMessage-ID: <fake.1>\nA note.\n')).toBe(true);
    expect(contentHasSecret('api_key=' + 'YOUR_KEY_HERE')).toBe(false);
    expect(contentHasSecret('api_key=' + 'xxxxxxxx')).toBe(false);
    expect(contentHasSecret('api_key=' + 'EXAMPLEabc123def456')).toBe(false);
    expect(contentHasSecret('api_key=' + 'ALLCAPSWITH123DIGITS')).toBe(false);
    expect(contentHasSecret('api_key: YOUR_KEY_HERE')).toBe(false);
    expect(contentHasSecret('access_token: YOUR_TOKEN_HERE')).toBe(false);
    expect(contentHasSecret('api_key=' + 'not-a-real-value')).toBe(true);
    expect(contentHasSecret('api_key: ' + 'ab12cd34ef56gh78')).toBe(true);
    expect(deniedExportContent('---\nfrom: the notes\ndate: Tuesday\n---\nFrom: ' + 'ada' + '@' + 'example.com' + '\nSubject: hello\n')).toBe(true);
    expect(deniedExportContent('Subject: weekly plan\n\nOrdinary notes from the meeting.\n')).toBe(false);
    expect(deniedExportContent('Date: Thursday\nSubject: weekly plan\n\nBring the notes.\n')).toBe(false);
    expect(deniedExportContent('---\nfrom: weekly\ndate: 2026-11-12\n---\nNotes about the plan.\n')).toBe(false);
    expect(deniedExportContent('A fake fact.')).toBe(false);
  });
});

describe('multi-account drops', () => {
  test('two accounts ingest a good drop and tag pages with account and bot', async () => {
    const home = temp('gbrain-export-good-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-b', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bot account-a/bot-a source=account-a');
    expect(result.summaryText).toContain('bot account-b/bot-b source=account-b');
    expect(puts.map((put) => put.slug).sort()).toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-b/bot-b/skills/daily');
    const page = puts.find((put) => put.slug === 'account-a/bot-a/memory')!.text;
    expect(existsSync(join(share, 'pages-a', 'account-a', 'bot-a', 'memory.md'))).toBe(false);
    expect(puts.every((put) => !put.file.startsWith(join(share, 'pages-a')) && !put.file.startsWith(join(share, 'pages-b')))).toBe(true);
    expect(page).toContain('account: "account-a"');
    expect(page).toContain('bot: "bot-a"');
    expect(page).toContain('## 2026-11-12');
    expect(puts.filter((put) => put.source === 'account-a')).toHaveLength(5);
    expect(puts.filter((put) => put.source === 'account-b')).toHaveLength(5);
  });

  test('a sha mismatch is skipped and the rest of the bot is imported', async () => {
    const home = temp('gbrain-export-hash-');
    const share = join(home, 'share');
    const files = goodFiles('bot-a');
    files['memory.md'] = '# Memory\n\n## 2026-11-12\n\nA fake fact.\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', files);
    writeFileSync(join(share, 'drops', '_box-export', 'bot-a', 'memory.md'), '# Memory\n\n## 2026-11-12\n\nA fake tale.\n');
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('hash mismatch memory.md');
    expect(puts.map((put) => put.slug)).not.toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/profile');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/routines');
  });

  test('a size mismatch is skipped when the sha256 still matches', async () => {
    const home = temp('gbrain-export-size-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => {
      const files = manifest.files as Record<string, { size: number; sha256: string }>;
      files['memory.md']!.size += 1;
    });
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('size mismatch memory.md');
    expect(result.summaryText).not.toContain('hash mismatch memory.md');
    expect(puts.map((put) => put.slug)).not.toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/profile');
  });

  test('a listed file that is gone logs missing', async () => {
    const home = temp('gbrain-export-gone-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    unlinkSync(join(dir, 'memory.md'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('missing memory.md');
    expect(result.summaryText).not.toContain('hash mismatch memory.md');
    expect(puts.map((put) => put.slug)).not.toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/profile');
  });

  test('an unknown manifest key imports nothing from that folder', async () => {
    const home = temp('gbrain-export-extra-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => { manifest.extra = 'nope'; });
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bad manifest');
    expect(puts).toHaveLength(0);
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => {
      const files = manifest.files as Record<string, Record<string, unknown>>;
      files['memory.md']!.note = 'extra';
    });
    const again = fakeBrain();
    const fileKey = await run(configFor(home, share, [roots(share)[0]!]), again.brain);
    expect(fileKey.summaryText).toContain('bad manifest');
    expect(again.puts).toHaveLength(0);
  });

  test('a stamp outside the age window imports nothing', async () => {
    const home = temp('gbrain-export-stale-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    const config = configFor(home, share, [roots(share)[0]!]);
    const old = fakeBrain();
    const stale = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain: old.brain,
      now: new Date('2026-11-14T12:00:00Z'),
    });
    expect(stale.exitCode).toBe(0);
    expect(stale.summaryText).toContain('stale');
    expect(old.puts).toHaveLength(0);
    const ahead = fakeBrain();
    const future = await runLoader({
      config,
      hostname: 'test-host',
      isMounted: () => true,
      brain: ahead.brain,
      now: new Date('2026-11-10T12:00:00Z'),
    });
    expect(future.summaryText).toContain('stale');
    expect(ahead.puts).toHaveLength(0);
  });

  test('address-less mail is not exported and placeholder keys are', () => {
    const home = temp('gbrain-export-mail-keys-');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"bot-a","name":"Bot A"}\n');
    write(join(agent, 'memory/log/2026-11-12.md'), 'Remember the fake fact.\n');
    const notes: Record<string, string> = {
      'invoice.md': 'From: Ada Example\nSubject: Re: invoice\nDate: Tue, 12 Nov 2026 02:00:00 -0500\n\nA pasted note with no address.\n',
      'titled.md': 'Invoice follow-up\nFrom: Ada Example\nSubject: Re: invoice\nDate: Tuesday\n',
      'titled-blank.md': 'Invoice follow-up\n\nFrom: Ada Example\nSubject: Re: invoice\nDate: Tuesday\n',
      'quoted.md': '> From: Ada Example\n> Subject: Re: invoice\n> Date: Tuesday\n',
      'indented.md': '  From: Ada Example\n  Subject: Re: invoice\n  Date: Tuesday\n',
      'outlook.md': 'From: Ada Example\nSent: Thursday, November 12, 2026 2:00 AM\nTo: Quinn Example\nSubject: Re: invoice\n',
      'original.md': '-----Original Message-----\nFrom: Ada Example\nSubject: Re: invoice\n\nPlease read the note.\n',
      'forward.md': '---------- Forwarded message ---------\nFrom: Ada Example\nDate: Tuesday\nSubject: Re: invoice\n\nA note.\n',
      'reply.md': 'On Thu, 12 Nov 2026, Ada Example wrote:\nThe invoice is a story.\n',
      'headers.md': 'From: Pat Example\nTo: Quinn Example\nSubject: notes\nDate: Tuesday\n',
      'table.md': '| From | To |\n| --- | --- |\n| Ada Example | Quinn Example |\n',
      'twoline.md': 'From: Ada Example\nSubject: Re: invoice\n',
      'yaml.md': '---\nfrom: the notes\ndate: Tuesday\n---\n\nThe plan is to walk the hill.\n',
      'meeting.md': 'Date: Tuesday\nSubject: tomorrow\'s plan\n',
      'point.md': 'To: the point of the meeting\nDate: Tuesday\n',
      'key-your.md': 'api_key=' + 'YOUR_KEY_HERE' + '\n',
      'key-x.md': 'api_key=' + 'xxxxxxxx' + '\n',
      'key-example.md': 'api_key=' + 'EXAMPLEabc123def456' + '\n',
      'key-caps.md': 'api_key=' + 'ALLCAPSWITH123DIGITS' + '\n',
      'key-colon.md': 'api_key: YOUR_KEY_HERE\n',
      'key-access.md': 'access_token: YOUR_TOKEN_HERE\n',
      'key-real.md': 'api_key=' + 'not-a-real-value' + '\n',
      'key-mixed.md': 'api_key: ' + 'ab12cd34ef56gh78' + '\n',
    };
    for (const [name, body] of Object.entries(notes)) write(join(agent, 'notes', name), body);
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'bot-a': agent } }));
    const out = join(home, 'out');
    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    for (const name of ['invoice.md', 'outlook.md', 'original.md', 'forward.md', 'reply.md', 'headers.md', 'titled.md', 'titled-blank.md', 'quoted.md', 'indented.md', 'key-real.md', 'key-mixed.md']) {
      expect(existsSync(join(out, 'bot-a/notes', name))).toBe(false);
    }
    for (const name of ['yaml.md', 'meeting.md', 'point.md', 'table.md', 'twoline.md', 'key-your.md', 'key-x.md', 'key-example.md', 'key-caps.md', 'key-colon.md', 'key-access.md']) {
      expect(existsSync(join(out, 'bot-a/notes', name))).toBe(true);
    }
  });

  test('a mail-shaped note drops the header lines and still loads', async () => {
    const home = temp('gbrain-export-mail-');
    const share = join(home, 'share');
    const files = goodFiles('bot-a');
    const canary = 'canary-mail@example.org';
    files['notes/body.md'] = 'From: ' + canary + '\nSubject: hello\n\nA note.\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', files);
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('export account-a/bot-a: redacted notes/body.md rule=deny.mail_headers line=1 count=2');
    expect(result.summaryText).not.toContain('secret rejected');
    expect(result.summaryText).not.toContain(canary);
    expect(result.summaryText).not.toContain('Subject:');
    const note = puts.find((put) => put.slug === 'account-a/bot-a/notes/body');
    expect(note?.text).toContain('A note.');
    expect(note?.text).not.toContain(canary);
    expect(note?.text).not.toContain('From:');
    expect(note?.text).not.toContain('Subject:');
  });

  test('a bad manifest imports nothing from that folder', async () => {
    const home = temp('gbrain-export-bad-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => { manifest.version = 2; });
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('bad manifest');
    expect(puts).toHaveLength(0);
    expect(existsSync(join(share, 'pages-a', 'account-a', 'bot-a', 'profile.md'))).toBe(false);
  });

  test('an account mismatch skips that bot and still imports the other account', async () => {
    const home = temp('gbrain-export-acct-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-a', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('account-b/bot-b: account mismatch');
    expect(puts.every((put) => put.source === 'account-a')).toBe(true);
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/memory');
    expect(puts.map((put) => put.slug).join(' ')).not.toContain('account-b');
  });

  test('a secret in one bot rejects that folder and does not reject the other account', async () => {
    const home = temp('gbrain-export-secret-');
    const share = join(home, 'share');
    const tainted = goodFiles('bot-a');
    tainted['memory.md'] = '# Memory\n\n-----BEGIN OPENSSH PRIVATE KEY-----\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', tainted);
    writeBot(join(share, 'drops', '_box-export-account-b', 'bot-b'), 'account-b', 'bot-b', goodFiles('bot-b'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, roots(share)), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('account-a/bot-a: secret rejected memory.md rule=secrets.content[0] line=3');
    expect(result.summaryText).toContain('account-a/bot-a: secret rejected\n');
    expect(result.summaryText).not.toContain('BEGIN');
    expect(result.summaryText).not.toContain('PRIVATE');
    expect(puts.every((put) => put.source === 'account-b')).toBe(true);
    expect(existsSync(join(share, 'pages-a', 'account-a'))).toBe(false);
  });

  test('a walked file name names the rule and not a secret value', async () => {
    const home = temp('gbrain-export-name-');
    const share = join(home, 'share');
    const files = goodFiles('bot-a');
    files['notes/api-token.txt'] = 'A note about a word.\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', files);
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('export account-a/bot-a: secret rejected notes/api-token.txt rule=secrets.names[9]');
    expect(result.summaryText).not.toContain('line=');
    expect(result.summaryText).toContain('account-a/bot-a: secret rejected\n');
    expect(puts).toHaveLength(0);
  });

  test('a manifest value names the rule and line and hides the value', async () => {
    const home = temp('gbrain-export-manifest-secret-');
    const share = join(home, 'share');
    const canary = 'CANARY-MANIFEST-9f3a';
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    const path = join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { bot_name: string };
    manifest.bot_name = 'api_key=' + canary;
    writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('export account-a/bot-a: secret rejected manifest.json rule=secrets.key_assignment line=3');
    expect(result.summaryText).toContain('account-a/bot-a: secret rejected\n');
    expect(result.summaryText).not.toContain(canary);
    expect(puts).toHaveLength(0);
  });

  test('a content secret warning names the rule and line and hides the canary', async () => {
    const home = temp('gbrain-export-canary-');
    const share = join(home, 'share');
    const canary = 'CANARY-SECRET-VALUE-9f3a';
    const tainted = goodFiles('bot-a');
    tainted['routines.md'] = 'A fake fact.\napi_key=' + canary + '\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', tainted);
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('export account-a/bot-a: secret rejected routines.md rule=secrets.key_assignment line=2');
    expect(result.summaryText).not.toContain(canary);
    expect(result.summaryText).not.toContain('api_key=');
    expect(puts).toHaveLength(0);
  });

  test('a symlink and a path escape are not followed', async () => {
    const home = temp('gbrain-export-link-');
    const share = join(home, 'share');
    const outside = join(home, 'outside.md');
    write(outside, 'outside canary\n');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    symlinkSync(outside, join(dir, 'skills', 'linked.md'));
    const { brain, puts } = fakeBrain();
    const linked = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(linked.exitCode).toBe(0);
    expect(linked.summaryText).toContain('symlink');
    expect(puts).toHaveLength(0);
    expect(linked.summaryText).not.toContain('outside canary');

    const home2 = temp('gbrain-export-escape-');
    const share2 = join(home2, 'share');
    const dir2 = join(share2, 'drops', '_box-export', 'bot-a');
    writeBot(dir2, 'account-a', 'bot-a', goodFiles('bot-a'), (manifest) => {
      const files = manifest.files as Record<string, { size: number; sha256: string }>;
      files['../outside.md'] = { size: 1, sha256: 'a'.repeat(64) };
    });
    const again = fakeBrain();
    const escaped = await run(configFor(home2, share2, [roots(share2)[0]!]), again.brain);
    expect(escaped.exitCode).toBe(0);
    expect(escaped.summaryText).toContain('path escape');
    expect(again.puts).toHaveLength(0);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside canary\n');
  });

  test('an unlisted file is ignored', async () => {
    const home = temp('gbrain-export-extra-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    write(join(dir, 'extra.md'), 'ignore me please\n');
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('ignored unlisted 1');
    expect(puts).toHaveLength(5);
    const dumped = puts.map((put) => put.text).join('\n');
    expect(dumped).not.toContain('ignore me please');
  });

  test('a manifest replaced mid-run imports nothing', async () => {
    const home = temp('gbrain-export-race-');
    const share = join(home, 'share');
    const dir = join(share, 'drops', '_box-export', 'bot-a');
    writeBot(dir, 'account-a', 'bot-a', goodFiles('bot-a'));
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain, (botDir) => {
      const path = join(botDir, 'manifest.json');
      const body = JSON.parse(readFileSync(path, 'utf8')) as { exported_at: string };
      body.exported_at = '2026-11-12T03:00:00-05:00';
      writeFileSync(path, JSON.stringify(body) + '\n');
    });
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('manifest changed');
    expect(puts).toHaveLength(0);
    expect(existsSync(join(share, 'pages-a', 'account-a'))).toBe(false);
  });

  test('a second run of the same drop writes nothing new', async () => {
    const home = temp('gbrain-export-again-');
    const share = join(home, 'share');
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', goodFiles('bot-a'));
    const { brain, puts } = fakeBrain();
    const config = configFor(home, share, [roots(share)[0]!]);
    const first = await run(config, brain);
    expect(first.exitCode).toBe(0);
    expect(first.summaryText).toContain('written=5');
    const count = puts.length;
    const second = await run(config, brain);
    expect(second.exitCode).toBe(0);
    expect(second.summaryText).toContain('written=0');
    expect(second.summaryText).toContain('unchanged=5');
    expect(puts).toHaveLength(count);
  });

  test('the exporter drop is ingested, and a bad root name or a fail-closed stamp is refused', async () => {
    const home = temp('gbrain-export-producer-');
    const share = join(home, 'share');
    const agent = join(home, 'agent');
    write(join(agent, 'profile.json'), '{"id":"bot-a","name":"Bot A"}\n');
    write(join(agent, 'memory/log/2026-11-12.md'), 'Remember the fake fact.\n');
    write(join(agent, 'routines.json'), '[{"name":"morning","schedule":"0 2 * * *","prompt":"Summarize the day."}]\n');
    write(join(agent, 'skills/daily.md'), '# Daily\n\nSay hello.\n');
    write(join(agent, 'skills/holdings.md'), 'nope\n');
    write(join(agent, 'notes', 'reach.md'), 'call ' + '555' + '-' + '010' + '-' + '0199' + '\n');
    write(join(agent, 'notes', 'body.md'), 'From: ' + 'ada' + '@' + 'example.com' + '\nSubject: hello\n\nA note.\n');
    write(join(agent, 'notes', 'paste.md'), 'From: Ada Example\nSubject: Re: invoice\nDate: Thursday\n\nA note.\n');
    write(join(agent, 'notes', 'sample-key.md'), 'api_key=YOUR_KEY_HERE\n');
    write(join(agent, 'notes', 'live-key.md'), 'api_key=' + 'not-a-real-value' + '\n');
    const cfg = join(home, 'box.json');
    writeFileSync(cfg, JSON.stringify({ bots: { 'bot-a': agent } }));
    const out = join(home, 'share', 'drops', '_box-export');
    const wet = spawnSync('python3', [BOX, cfg, '--out', out, '--account', 'account-a'], { encoding: 'utf8' });
    expect(wet.status).toBe(0);
    expect(wet.stdout).not.toContain('555');
    const memory = readFileSync(join(out, 'bot-a/memory.md'), 'utf8');
    expect(memory).toContain('## 2026-11-12');
    expect(memory).toContain('Remember the fake fact.');
    expect(existsSync(join(out, 'bot-a/skills/holdings.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/reach.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/body.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/paste.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/live-key.md'))).toBe(false);
    expect(existsSync(join(out, 'bot-a/notes/sample-key.md'))).toBe(true);
    const routines = readFileSync(join(out, 'bot-a/routines.md'), 'utf8');
    expect(routines).toContain('schedule:');
    expect(routines).toContain('prompt:');
    const manifest = JSON.parse(readFileSync(join(out, 'bot-a/manifest.json'), 'utf8')) as { exported_at: string; account: string };
    expect(manifest.account).toBe('account-a');
    expect(isNewYorkExportTime(manifest.exported_at)).toBe(true);
    const { brain, puts } = fakeBrain();
    const loaded = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(loaded.exitCode).toBe(0);
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/memory');
    expect(puts.find((put) => put.slug === 'account-a/bot-a/memory')!.text).toContain('Remember the fake fact.');
    expect(puts.map((put) => put.slug).join(' ')).not.toContain('holdings');

    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify({
      share_root: share,
      gbrain_bin: '/usr/bin/gbrain',
      groups: [{ id: 'personal', source: 'personal', target_root: join(share, 'personal-pages'), bots: [] }],
      export_roots: [{ account: 'account-a', path: join(share, 'drops', 'feed'), source: 'account-a', target_root: join(share, 'pages-a') }],
    }));
    expect(() => loadConfig(bad, home)).toThrow(/_box-export/);

    const stamp = join(share, 'feeds', '_box-export');
    mkdirSync(stamp, { recursive: true });
    const closed = join(home, 'closed.json');
    writeFileSync(closed, JSON.stringify({
      share_root: share,
      gbrain_bin: '/usr/bin/gbrain',
      box_export_dir: join(share, 'other', '_box-export'),
      groups: [{
        id: 'hermes',
        source: 'hermes',
        account: 'hermes',
        fail_closed: true,
        stamp_root: stamp,
        target_root: join(share, 'hermes-pages'),
        extensions: ['.md', '.txt'],
        bots: [{ id: 'bot-a', inputs: [{ path: stamp, required: false, role: 'local-feed' }] }],
      }],
      export_roots: [{ account: 'account-a', path: stamp, source: 'account-a', target_root: join(share, 'pages-a') }],
    }));
    expect(() => loadConfig(closed, home)).toThrow(/fail-closed stamp_root/);
  });

  test('export-deny content is redacted in place and a second run is unchanged', async () => {
    const home = temp('gbrain-export-redact-bots-');
    const share = join(home, 'share');
    const root = join(share, 'drops', '_box-export');
    const emailB = 'canary-b@example.org';
    const emailC = 'canary-c@example.org';
    const emailE = 'canary-e@example.org';
    const street = '12 Canary9f3a Street';
    const atLine = (line: number, hit: string): string => {
      const rows: string[] = [];
      for (let i = 1; i < line; i += 1) rows.push('A fake fact.');
      rows.push(hit);
      return rows.join('\n') + '\n';
    };
    const botA = goodFiles('bot-a');
    botA['routines.md'] = atLine(17, 'See the holdings note.');
    const botB = goodFiles('bot-b');
    botB['memory.md'] = atLine(55, 'Write ' + emailB + ' later.');
    const botC = goodFiles('bot-c');
    botC['memory.md'] = atLine(36, 'Write ' + emailC + ' later.');
    const botD = goodFiles('bot-d');
    botD['routines.md'] = atLine(18, 'See the holdings note.');
    const botE = goodFiles('bot-e');
    botE['memory.md'] = atLine(3, 'Write ' + emailE + ' later.');
    botE['routines.md'] = atLine(18, 'See the holdings note.');
    botE['notes/handoff-x.md'] = atLine(228, 'Meet at ' + street + ' tomorrow.');
    writeBot(join(root, 'bot-a'), 'account-a', 'bot-a', botA);
    writeBot(join(root, 'bot-b'), 'account-a', 'bot-b', botB);
    writeBot(join(root, 'bot-c'), 'account-a', 'bot-c', botC);
    writeBot(join(root, 'bot-d'), 'account-a', 'bot-d', botD);
    writeBot(join(root, 'bot-e'), 'account-a', 'bot-e', botE);
    const config = configFor(home, share, [roots(share)[0]!]);
    const { brain, puts } = fakeBrain();
    const result = await run(config, brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).not.toContain('secret rejected');
    for (const canary of [emailB, emailC, emailE, 'Canary9f3a', 'holdings']) {
      expect(result.summaryText).not.toContain(canary);
    }
    expect(result.summaryText).toContain('export account-a/bot-a: redacted routines.md rule=deny.content[12] line=17 count=1');
    expect(result.summaryText).toContain('export account-a/bot-b: redacted memory.md rule=deny.content[0] line=55 count=1');
    expect(result.summaryText).toContain('export account-a/bot-c: redacted memory.md rule=deny.content[0] line=36 count=1');
    expect(result.summaryText).toContain('export account-a/bot-d: redacted routines.md rule=deny.content[12] line=18 count=1');
    expect(result.summaryText).toContain('export account-a/bot-e: redacted memory.md rule=deny.content[0] line=3 count=1');
    expect(result.summaryText).toContain('export account-a/bot-e: redacted routines.md rule=deny.content[12] line=18 count=1');
    expect(result.summaryText).toContain('export account-a/bot-e: redacted notes/handoff-x.md rule=deny.content[6] line=228 count=1');
    expect(result.summaryText).toContain('redacted_hits=1');
    expect(result.summaryText).toContain('bot account-a/bot-e source=account-a');
    expect(result.summaryText).toMatch(/bot account-a\/bot-e source=account-a .* redacted_hits=3 /);
    const body = puts.map((put) => put.text).join('\n');
    expect(body).toContain('positions-summary');
    expect(body).toContain('<email>');
    expect(body).toContain('<address>');
    expect(body).not.toContain('holdings');
    expect(body).not.toContain(emailB);
    expect(body).not.toContain(emailC);
    expect(body).not.toContain(emailE);
    expect(body).not.toContain('Canary9f3a');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-a/routines');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-b/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-c/memory');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-d/routines');
    expect(puts.map((put) => put.slug)).toContain('account-a/bot-e/notes/handoff-x');

    const second = fakeBrain();
    const again = await run(config, second.brain);
    expect(again.exitCode).toBe(0);
    expect(second.puts).toHaveLength(0);
    expect(again.summaryText).toMatch(/bot account-a\/bot-a source=account-a scanned=5 written=0 unchanged=5 /);
  });

  test('a jwt beside an email still rejects the bot, and a raw hash mismatch is not redacted', async () => {
    const home = temp('gbrain-export-jwt-');
    const share = join(home, 'share');
    const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.signaturevalue';
    const email = 'canary-j@example.org';
    const tainted = goodFiles('bot-a');
    tainted['memory.md'] = '# Memory\n\n' + jwt + '\n' + email + '\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', tainted);
    const { brain, puts } = fakeBrain();
    const result = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(result.exitCode).toBe(0);
    expect(result.summaryText).toContain('secret rejected memory.md rule=secrets.content[21] line=3');
    expect(result.summaryText).not.toContain(jwt);
    expect(result.summaryText).not.toContain(email);
    expect(result.summaryText).not.toContain('redacted ');
    expect(puts).toHaveLength(0);

    const home2 = temp('gbrain-export-hash-email-');
    const share2 = join(home2, 'share');
    const dir2 = join(share2, 'drops', '_box-export', 'bot-a');
    writeBot(dir2, 'account-a', 'bot-a', goodFiles('bot-a'));
    const body = 'Write ' + email + ' later.\n';
    writeFileSync(join(dir2, 'memory.md'), body);
    const manifestPath = join(dir2, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, { size: number; sha256: string }> };
    manifest.files['memory.md']!.size = Buffer.from(body).length;
    manifest.files['memory.md']!.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest) + '\n');
    const hashed = fakeBrain();
    const mismatch = await run(configFor(home2, share2, [roots(share2)[0]!]), hashed.brain);
    expect(mismatch.summaryText).toContain('hash mismatch memory.md');
    expect(mismatch.summaryText).not.toContain('redacted memory.md');
    expect(mismatch.summaryText).not.toContain(email);
    expect(hashed.puts.map((put) => put.slug)).not.toContain('account-a/bot-a/memory');
    expect(hashed.puts.map((put) => put.slug)).toContain('account-a/bot-a/profile');
  });

  test('a deny key assignment still rejects, and phone, ssn, card, and account numbers redact', async () => {
    const home = temp('gbrain-export-key-block-');
    const share = join(home, 'share');
    const tainted = goodFiles('bot-a');
    tainted['routines.md'] = 'See api_key=' + 'not-a-real-value' + ' in the note.\n';
    writeBot(join(share, 'drops', '_box-export', 'bot-a'), 'account-a', 'bot-a', tainted);
    const { brain, puts } = fakeBrain();
    const blocked = await run(configFor(home, share, [roots(share)[0]!]), brain);
    expect(blocked.summaryText).toContain('secret rejected routines.md rule=deny.key_assignment line=1');
    expect(blocked.summaryText).not.toContain('not-a-real-value');
    expect(puts).toHaveLength(0);

    const fixtures = JSON.parse(readFileSync(join(REPO, 'scripts/bot-loader/redact-fixtures.json'), 'utf8')) as {
      cases: { name: string; input: string; output: string; hits: { rule: string; line: number; count: number }[] }[];
    };
    for (const row of fixtures.cases) {
      const redacted = redactExportDenyContent(row.input);
      expect(redacted.text).toBe(row.output);
      expect(redacted.hits).toEqual(row.hits);
      const again = redactExportDenyContent(redacted.text);
      expect(again.text).toBe(redacted.text);
      expect(again.hits).toEqual([]);
    }
  });
});
