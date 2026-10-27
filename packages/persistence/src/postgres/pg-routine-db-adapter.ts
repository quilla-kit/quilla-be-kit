import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import { routineOutputNames } from '../db-adapter/routine-arguments.js';
import type {
  RoutineDbAdapter,
  StoredFunctionCall,
  StoredFunctionResult,
  StoredProcedureCall,
  StoredProcedureResult,
} from '../db-adapter/routine-db-adapter.interface.js';
import { IDENT, IDENT_RE, type IdentifierQuoter, NO_QUOTING, QUOTED } from './pg-sql.js';

// A type name with an optional schema, `(p[,s])` modifiers on any word and
// trailing array brackets: `uuid`, `numeric(10,2)[]`, `timestamp(3) with time zone`.
const MODIFIER = String.raw`\(\s*\d+\s*(,\s*\d+\s*)?\)`;
const TYPE_RE = new RegExp(
  String.raw`^${IDENT}(\.${IDENT})?(${MODIFIER})?(\s+${IDENT}(${MODIFIER})?)*(\[\d*\])*$`,
);

type RenderedCall = {
  readonly target: string;
  readonly params: readonly unknown[];
  readonly outputNames: readonly string[];
};

export type PgRoutineDbAdapterOptions = {
  readonly quoteIdentifiers?: boolean;
};

/**
 * Postgres `RoutineDbAdapter`. Functions don't accept OUT arguments, so they
 * are left out of function calls and read back from the result columns.
 */
export class PgRoutineDbAdapter implements RoutineDbAdapter {
  private readonly quoter: IdentifierQuoter;

  constructor(
    private readonly db: Database,
    options: PgRoutineDbAdapterOptions = {},
  ) {
    this.quoter = options.quoteIdentifiers ? QUOTED : NO_QUOTING;
  }

  async callProcedure<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredProcedureCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredProcedureResult<TOut, TRow>> {
    const { target, params, outputNames } = this.render(call, true);
    const result = await this.db.query(`CALL ${target}`, params, trx);
    return { outputs: pickOutputs<TOut>(result.rows[0], outputNames), rows: [] };
  }

  async callFunction<TOut = Record<string, unknown>, TRow = Record<string, unknown>>(
    call: StoredFunctionCall,
    trx?: DatabaseTransaction,
  ): Promise<StoredFunctionResult<TOut, TRow>> {
    const { target, params, outputNames } = this.render(call, false);
    if (call.returns === 'value') {
      if (outputNames.length > 0) {
        throw new Error(
          `Routine ${JSON.stringify(call.routine)}: out/inout arguments come back as columns; use returns: 'rows'.`,
        );
      }
      const result = await this.db.query(`SELECT ${target} AS "returnValue"`, params, trx);
      return { outputs: {} as TOut, rows: [], returnValue: result.rows[0]?.returnValue };
    }
    const result = await this.db.query(`SELECT * FROM ${target}`, params, trx);
    return {
      outputs: pickOutputs<TOut>(result.rows[0], outputNames),
      rows: result.rows as readonly TRow[],
    };
  }

  private render(call: StoredProcedureCall, passOutArgs: boolean): RenderedCall {
    const outputNames = routineOutputNames(call);
    const params: unknown[] = [];
    const parts: string[] = [];

    for (const arg of call.args ?? []) {
      if (arg.mode === 'out' && !passOutArgs) continue;
      const cast = arg.type === undefined ? '' : `::${validateType(arg.type)}`;
      let expr: string;
      if (arg.mode === 'out') {
        expr = `NULL${cast}`;
      } else {
        params.push(arg.value);
        expr = `$${params.length}${cast}`;
      }
      parts.push(arg.name === undefined ? expr : `${this.identifier(arg.name)} => ${expr}`);
    }

    const routine =
      call.schema === undefined
        ? this.identifier(call.routine)
        : `${this.identifier(call.schema)}.${this.identifier(call.routine)}`;
    return { target: `${routine}(${parts.join(', ')})`, params, outputNames };
  }

  private identifier(name: string): string {
    if (this.quoter === NO_QUOTING && !IDENT_RE.test(name)) {
      throw new Error(
        `PgRoutineDbAdapter: invalid identifier ${JSON.stringify(name)}. Without quoteIdentifiers, it must match ${IDENT_RE}.`,
      );
    }
    return this.quoter.column(name);
  }
}

function validateType(type: string): string {
  if (!TYPE_RE.test(type)) {
    throw new Error(`PgRoutineDbAdapter: invalid type name ${JSON.stringify(type)}.`);
  }
  return type;
}

function pickOutputs<TOut>(
  row: Readonly<Record<string, unknown>> | undefined,
  names: readonly string[],
): TOut {
  const outputs: Record<string, unknown> = {};
  for (const name of names) {
    outputs[name] = row?.[name];
  }
  return outputs as TOut;
}
