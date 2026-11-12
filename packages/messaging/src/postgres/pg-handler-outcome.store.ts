import type { Pool } from 'pg';
import type {
  ClearHandlerOutcomesOptions,
  HandlerOutcome,
  HandlerOutcomeStore,
} from '../event-bus/handler-outcome-store.interface.js';
import { pgErrorCode } from './missing-column.error.js';

const DEFAULT_TABLE = 'event_handler_outcomes';
const FOREIGN_KEY_VIOLATION = '23503';

type OutcomeRow = {
  event_id: string;
  handler_key: string;
  outcome: HandlerOutcome['outcome'];
  error: string | null;
};

export type PgHandlerOutcomeStoreOptions = {
  readonly pool: Pool;
  readonly tableName?: string;
};

// Rows cascade away with their bus row (getPostgresSchema({ handlerOutcomes })).
export class PgHandlerOutcomeStore implements HandlerOutcomeStore {
  private readonly pool: Pool;
  private readonly table: string;

  constructor(options: PgHandlerOutcomeStoreOptions) {
    this.pool = options.pool;
    this.table = options.tableName ?? DEFAULT_TABLE;
  }

  async load(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly HandlerOutcome[]>> {
    const result = new Map<string, HandlerOutcome[]>();
    if (eventIds.length === 0) return result;
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT event_id, handler_key, outcome, error FROM ${this.table} WHERE event_id = ANY($1)`,
      [[...eventIds]],
    );
    for (const row of rows) {
      const outcomes = result.get(row.event_id) ?? [];
      outcomes.push({
        key: row.handler_key,
        outcome: row.outcome,
        ...(row.error !== null ? { error: row.error } : {}),
      });
      result.set(row.event_id, outcomes);
    }
    return result;
  }

  async record(eventId: string, outcomes: readonly HandlerOutcome[]): Promise<void> {
    if (outcomes.length === 0) return;
    try {
      await this.pool.query(
        `INSERT INTO ${this.table} AS t (event_id, handler_key, outcome, error, recorded_at)
           SELECT $1::uuid, o.handler_key, o.outcome, o.error, $5::timestamptz
           FROM unnest($2::text[], $3::text[], $4::text[]) AS o(handler_key, outcome, error)
           ON CONFLICT (event_id, handler_key) DO UPDATE
             SET outcome = EXCLUDED.outcome, error = EXCLUDED.error, recorded_at = EXCLUDED.recorded_at
             WHERE t.outcome <> 'done'`,
        [
          eventId,
          outcomes.map((o) => o.key),
          outcomes.map((o) => o.outcome),
          outcomes.map((o) => o.error ?? null),
          new Date(),
        ],
      );
    } catch (err) {
      // The bus row is gone (another replica settled it): nothing left to record against.
      if (pgErrorCode(err) === FOREIGN_KEY_VIOLATION) return;
      throw err;
    }
  }

  async clear(eventIds: readonly string[], options?: ClearHandlerOutcomesOptions): Promise<void> {
    if (eventIds.length === 0) return;
    const onlyDead = options?.includeDone ? '' : " AND outcome = 'dead'";
    await this.pool.query(`DELETE FROM ${this.table} WHERE event_id = ANY($1)${onlyDead}`, [
      [...eventIds],
    ]);
  }
}
