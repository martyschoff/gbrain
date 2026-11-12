export interface BotSummary {
  id: string;
  source: string;
  scanned: number;
  written: number;
  unchanged: number;
  skipped: number;
  secretsSkipped: number;
  pages: number;
}

export interface RunSummary {
  ok: boolean;
  bots: BotSummary[];
  sources: { id: string; pages: number; via: string }[];
  orphans: { bot: string; count: number }[];
  warnings: string[];
  /** Exact `SKIP <source>: ...` lines. They do not change `ok`. */
  skips?: string[];
}

export function formatSummary(summary: RunSummary): string {
  const lines = [`bot-loader: ${summary.ok ? 'ok' : 'failed'}`];
  for (const bot of summary.bots) {
    lines.push(
      `bot ${bot.id} source=${bot.source} scanned=${bot.scanned} written=${bot.written} unchanged=${bot.unchanged} skipped=${bot.skipped} secrets_skipped=${bot.secretsSkipped} pages=${bot.pages}`,
    );
  }
  for (const source of summary.sources) lines.push(`source ${source.id} pages=${source.pages} via=${source.via}`);
  for (const orphan of summary.orphans) lines.push(`orphaned ${orphan.bot} ${orphan.count}`);
  for (const skip of summary.skips ?? []) lines.push(skip);
  for (const warning of summary.warnings) lines.push(`WARN ${warning}`);
  return lines.join('\n') + '\n';
}
