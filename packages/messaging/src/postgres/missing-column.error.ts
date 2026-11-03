import { InternalError } from '@quilla-be-kit/errors';

const UNDEFINED_COLUMN = '42703';
const KIT_COLUMNS = ['lease_expires_at', 'failed_at', 'seq'] as const;

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

export async function withColumnHint<T>(query: Promise<T>, table: string): Promise<T> {
  try {
    return await query;
  } catch (err) {
    const column = missingKitColumn(err);
    if (column !== undefined) throw new MissingColumnError(table, column, err);
    throw err;
  }
}

function missingKitColumn(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== UNDEFINED_COLUMN || typeof message !== 'string') return undefined;
  return KIT_COLUMNS.find((column) => message.includes(`"${column}"`));
}
