import type { Pool } from 'pg';
import type { EventBusConsumer } from '../event-bus/event-bus-consumer.interface.js';
import type { EventBusEntry, EventBusStatus } from '../event-bus/event-bus-entry.type.js';
import type { EventBusPublisher } from '../event-bus/event-bus-publisher.interface.js';

const DEFAULT_EVENTS_TABLE = 'events';
const DEFAULT_MAX_RETRIES = 3;

type EventsRow = {
  id: string;
  event_type: string;
  event_version: number;
  event_kind: string;
  payload: unknown;
  source_service: string;
  aggregate_id: string | null;
  correlation_id: string | null;
  status: EventBusStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  retry_count: number;
  last_error: string | null;
  created_at: Date;
  published_at: Date;
};

export type PgEventBusOptions = {
  readonly pool: Pool;
  readonly eventsTableName?: string;
  readonly maxRetries?: number;
};
export class PgEventBus implements EventBusPublisher, EventBusConsumer {
  private readonly pool: Pool;
  private readonly eventsTable: string;
  private readonly maxRetries: number;

  constructor(options: PgEventBusOptions) {
    this.pool = options.pool;
    this.eventsTable = options.eventsTableName ?? DEFAULT_EVENTS_TABLE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async publish(event: Parameters<EventBusPublisher['publish']>[0]): Promise<void> {
    const publishedAt = new Date();
    await this.pool.query(
      `INSERT INTO ${this.eventsTable}
         (id, event_type, event_version, event_kind, payload, source_service,
          aggregate_id, correlation_id, status, claimed_by, claimed_at,
          retry_count, last_error, created_at, published_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        event.id,
        event.eventType,
        event.eventVersion,
        event.eventKind,
        JSON.stringify(event.payload),
        event.sourceService,
        event.aggregateId ?? null,
        event.correlationId ?? null,
        'PENDING',
        null,
        null,
        0,
        null,
        event.createdAt,
        publishedAt,
      ],
    );
  }

  // NOT EXISTS guards against claiming a second event for an aggregate while
  // an earlier one is still CLAIMED. Advisory xact lock closes the race
  // between NOT EXISTS and UPDATE across overlapping transactions.
  async claim(
    instanceId: string,
    batchSize: number,
    allowedTopics?: readonly string[],
  ): Promise<readonly EventBusEntry[]> {
    const topicFilter = allowedTopics && allowedTopics.length > 0 ? [...allowedTopics] : null;
    const result = await this.pool.query<EventsRow>(
      `WITH claimed AS (
         SELECT id FROM ${this.eventsTable} e
         WHERE e.status = 'PENDING'
           AND ($4::text[] IS NULL OR e.event_type = ANY($4))
           AND NOT EXISTS (
             SELECT 1 FROM ${this.eventsTable} e2
             WHERE e2.aggregate_id IS NOT NULL
               AND e2.aggregate_id = e.aggregate_id
               AND e2.status = 'CLAIMED'
           )
           AND (e.aggregate_id IS NULL
                OR pg_try_advisory_xact_lock(hashtext(e.aggregate_id)::bigint))
         ORDER BY e.created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.eventsTable} t
       SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3
       FROM claimed c
       WHERE t.id = c.id
       RETURNING t.*`,
      [batchSize, instanceId, new Date(), topicFilter],
    );
    return result.rows.map((r) => this.rowToEntry(r));
  }

  async markDone(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.eventsTable} WHERE id = $1`, [id]);
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.eventsTable}
       SET retry_count = retry_count + 1,
           last_error = $1,
           status = CASE WHEN retry_count + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
           claimed_by = NULL,
           claimed_at = NULL
       WHERE id = $2`,
      [reason, id, this.maxRetries],
    );
  }

  async resetStale(olderThan: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ${this.eventsTable}
       SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL
       WHERE status = 'CLAIMED' AND claimed_at < $1`,
      [olderThan],
    );
    return result.rowCount ?? 0;
  }

  async cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    const limit = options?.limit;
    const result = limit
      ? await this.pool.query(
          `WITH cte AS (
             SELECT id FROM ${this.eventsTable}
             WHERE status = 'FAILED' AND created_at < $1
             ORDER BY created_at ASC
             LIMIT $2
           )
           DELETE FROM ${this.eventsTable} t
           USING cte
           WHERE t.id = cte.id`,
          [olderThan, limit],
        )
      : await this.pool.query(
          `DELETE FROM ${this.eventsTable} WHERE status = 'FAILED' AND created_at < $1`,
          [olderThan],
        );
    return result.rowCount ?? 0;
  }

  private rowToEntry(row: EventsRow): EventBusEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventKind: row.event_kind,
      payload: row.payload,
      sourceService: row.source_service,
      ...(row.aggregate_id !== null ? { aggregateId: row.aggregate_id } : {}),
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      status: row.status,
      ...(row.claimed_by !== null ? { claimedBy: row.claimed_by } : {}),
      ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
      retryCount: row.retry_count,
      ...(row.last_error !== null ? { lastError: row.last_error } : {}),
      createdAt: row.created_at,
      publishedAt: row.published_at,
    };
  }
}
