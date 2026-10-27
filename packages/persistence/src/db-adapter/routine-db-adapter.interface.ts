import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

export type RoutineArgumentMode = 'in' | 'out' | 'inout';

/** `out`/`inout` arguments must be named so their values come back by name. */
export type RoutineArgument = {
  readonly name?: string;
  readonly mode?: RoutineArgumentMode;
  readonly value?: unknown;
  readonly type?: string;
};

export type StoredProcedureCall = {
  readonly schema?: string;
  readonly routine: string;
  readonly args?: readonly RoutineArgument[];
};

export type StoredFunctionCall = StoredProcedureCall & {
  readonly returns?: 'rows' | 'value';
};

export type StoredProcedureResult<TOut, TRow> = {
  readonly outputs: TOut;
  readonly rows: readonly TRow[];
};

export type StoredFunctionResult<TOut, TRow> = StoredProcedureResult<TOut, TRow> & {
  readonly returnValue?: unknown;
};

/** Adapters call `routineOutputNames` to enforce the argument rules every dialect shares. */
export interface RoutineDbAdapter {
  callProcedure<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredProcedureCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredProcedureResult<TOut, TRow>>;

  callFunction<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredFunctionCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredFunctionResult<TOut, TRow>>;
}
