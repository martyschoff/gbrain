import type { BrainEngine } from './engine.ts';
import { opError, type OperationError } from './ops/contract.ts';
import { readFix } from './ops/op-fix.ts';

/** Postgres UNIQUE on `sources.name` (both engines report `constraint` or `constraint_name`). */
export const SOURCE_NAME_CONSTRAINT = 'sources_name_key';

export function isSourceNameUniqueViolation(error: unknown): boolean {
  const e = (error ?? {}) as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  return String(e.code) === '23505' && (e.constraint_name ?? e.constraint) === SOURCE_NAME_CONSTRAINT;
}

/** Caller-facing refusal. The holder's id stays off the wire: a caller who can add may not be allowed to list it. */
export function sourceNameTaken(sourceId: string): OperationError {
  return opError(
    'source_name_taken',
    'Display name already in use.',
    `Pick a different --name for '${sourceId}'. Display names are unique across sources, so nothing was registered.`,
    {
      retryable: false,
      fix: readFix('Lists the sources this caller can see, read-only.', { argv: ['gbrain', 'sources', 'list', '--json'] }),
    },
  );
}

export async function assertSourceNameFree(engine: BrainEngine, id: string, name: string): Promise<void> {
  const [other] = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE name = $1 AND id <> $2 LIMIT 1`,
    [name, id],
  );
  if (other) throw sourceNameTaken(id);
}

/**
 * A write that lost the race for `sources.name` (23505 on `sources_name_key`).
 * The re-check runs on `engine` after the failed statement, the same shape as
 * `refuseEmailRace`: an aborted transaction is not queried again.
 */
export async function refuseSourceNameRace(
  engine: BrainEngine,
  error: unknown,
  id: string,
  name: string | null | undefined,
): Promise<never> {
  if (name != null && name !== '' && isSourceNameUniqueViolation(error)) await assertSourceNameFree(engine, id, name);
  throw error;
}
