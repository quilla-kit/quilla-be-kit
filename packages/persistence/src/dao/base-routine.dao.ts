import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type {
  RoutineDbAdapter,
  StoredFunctionCall,
  StoredFunctionResult,
  StoredProcedureCall,
  StoredProcedureResult,
} from '../db-adapter/routine-db-adapter.interface.js';

/**
 * Routine-side DAO. Subclass and add one typed method per stored procedure
 * or function; a single subclass can group any number of routines. `schema`
 * applies to every call that doesn't set its own.
 */
export abstract class BaseRoutineDao {
  protected readonly schema?: string;

  constructor(protected readonly adapter: RoutineDbAdapter) {}

  protected callProcedure<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredProcedureCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredProcedureResult<TOut, TRow>> {
    return this.adapter.callProcedure<TOut, TRow>(this.withSchema(call), trx);
  }

  protected callFunction<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredFunctionCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredFunctionResult<TOut, TRow>> {
    return this.adapter.callFunction<TOut, TRow>(this.withSchema(call), trx);
  }

  private withSchema<T extends StoredProcedureCall>(call: T): T {
    const schema = call.schema ?? this.schema;
    return schema === undefined ? call : { ...call, schema };
  }
}
