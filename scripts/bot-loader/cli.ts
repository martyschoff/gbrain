import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { expandHome } from './files.ts';
import { runLoader } from './run.ts';
import { shareIsMounted } from './host.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return undefined;
  return value;
}

const home = process.env.HOME ?? '';
const configPath = resolve(expandHome(arg('--config') ?? process.env.GBRAIN_BOT_LOADER_CONFIG ?? '~/.gbrain/bot-loader/config.json', home));
const assumeMounted = process.argv.includes('--assume-mounted') && process.env.GBRAIN_BOT_LOADER_TEST === '1';

const result = await runLoader({
  config: loadConfig(configPath, home),
  ...(assumeMounted ? { isMounted: () => true } : { isMounted: shareIsMounted }),
});
if (result.summaryText) process.stdout.write(result.summaryText);
process.exit(result.exitCode);
