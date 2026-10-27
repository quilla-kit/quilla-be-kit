import { InternalError } from '@quilla-be-kit/errors';

export class TooManyRowsError extends InternalError {
  override readonly code = 'TOO_MANY_ROWS';

  constructor(options: { readonly entity: string }) {
    super({
      message: `${options.entity}: expected at most one row, found more`,
      context: { entity: options.entity },
    });
  }
}

/** The only row, `null` for none; more than one throws `TooManyRowsError`. */
export function singleRow<T>(rows: readonly T[], entity: string): T | null {
  if (rows.length > 1) throw new TooManyRowsError({ entity });
  return rows[0] ?? null;
}
