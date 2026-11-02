import { InternalError } from '@quilla-be-kit/errors';

const UNDEFINED_COLUMN = '42703';

export class MissingLeaseColumnError extends InternalError {
  override readonly code = 'MISSING_LEASE_COLUMN';

  constructor(table: string, cause: unknown) {
    super({
      message: `${table}.lease_expires_at does not exist; apply the messaging 0.8.0 migration`,
      context: { table },
      cause,
    });
  }
}

export async function withLeaseColumnHint<T>(query: Promise<T>, table: string): Promise<T> {
  try {
    return await query;
  } catch (err) {
    if (isMissingLeaseColumn(err)) throw new MissingLeaseColumnError(table, err);
    throw err;
  }
}

function isMissingLeaseColumn(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (
    code === UNDEFINED_COLUMN && typeof message === 'string' && message.includes('lease_expires_at')
  );
}
