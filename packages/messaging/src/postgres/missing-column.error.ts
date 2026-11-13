import { InternalError } from '@quilla-be-kit/errors';

const UNDEFINED_COLUMN = '42703';
const UNDEFINED_TABLE = '42P01';
const KIT_COLUMNS = [
  'lease_expires_at',
  'failed_at',
  'seq',
  'last_failed_by',
  'next_attempt_at',
  'member',
  'event_seq',
  'holds_lane',
] as const;

export class MissingColumnError extends InternalError {
  override readonly code = 'MISSING_COLUMN';

  constructor(table: string, column: string, cause: unknown) {
    super({
      message: `${table}.${column} does not exist; apply the messaging migrations (README "Upgrading")`,
      context: { table, column },
      cause,
    });
  }
}

export class MissingTableError extends InternalError {
  override readonly code = 'MISSING_TABLE';

  constructor(table: string, cause: unknown) {
    super({
      message: `${table} does not exist; create it with getPostgresSchema (README "Schema"), including the options for the features you use`,
      context: { table },
      cause,
    });
  }
}

export async function withColumnHint<T>(query: Promise<T>, table: string): Promise<T> {
  try {
    return await query;
  } catch (err) {
    const column = missingKitColumn(err);
    if (column !== undefined) throw new MissingColumnError(table, column, err);
    const missing = missingTable(err);
    if (missing !== undefined) throw new MissingTableError(missing, err);
    throw err;
  }
}

export function pgErrorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

function missingKitColumn(err: unknown): string | undefined {
  if (pgErrorCode(err) !== UNDEFINED_COLUMN) return undefined;
  const { message } = err as { message?: unknown };
  if (typeof message !== 'string') return undefined;
  return KIT_COLUMNS.find((column) => message.includes(`"${column}"`));
}

function missingTable(err: unknown): string | undefined {
  if (pgErrorCode(err) !== UNDEFINED_TABLE) return undefined;
  const { message } = err as { message?: unknown };
  if (typeof message !== 'string') return undefined;
  return /relation "([^"]+)" does not exist/.exec(message)?.[1];
}
