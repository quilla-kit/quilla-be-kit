import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  LocalOutboxEntry,
  LocalOutboxInsertInput,
  LocalOutboxStatus,
} from '../local-outbox/local-outbox-entry.type.js';
import type { LocalOutboxReader } from '../local-outbox/local-outbox-reader.interface.js';
import type { LocalOutboxWriter } from '../local-outbox/local-outbox-writer.interface.js';
import type { TransactionHandle } from '../local-outbox/transaction-handle.interface.js';

const DEFAULT_TABLE_NAME = 'outbox_events';
const DEFAULT_MAX_RETRIES = 3;
const INSERT_COLUMN_COUNT = 14;

type OutboxRow = {
  id: string;
  event_type: string;
  event_version: number;
  event_kind: string;
  payload: unknown;
  aggregate_id: string | null;
  correlation_id: string | null;
  status: LocalOutboxStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  retry_count: number;
  last_error: string | null;
  published_at: Date | null;
  created_at: Date;
};

export type PgLocalOutboxOptions = {
  readonly pool: Pool;
  readonly tableName?: string;
  readonly maxRetries?: number;
};

export class PgLocalOutbox implements LocalOutboxWriter, LocalOutboxReader {
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly maxRetries: number;

  constructor(options: PgLocalOutboxOptions) {
    this.pool = options.pool;
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async insert(entries: readonly LocalOutboxInsertInput[], trx: TransactionHandle): Promise<void> {
    if (entries.length === 0) return;

    const params: unknown[] = [];
    const valueGroups: string[] = [];

    for (const [i, entry] of entries.entries()) {
      const base = i * INSERT_COLUMN_COUNT;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
          `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`,
      );
      params.push(
        entry.id ?? randomUUID(),
        entry.eventType,
        entry.eventVersion ?? 1,
        entry.eventKind,
        JSON.stringify(entry.payload),
        entry.aggregateId ?? null,
        entry.correlationId ?? null,
        'PENDING',
        null,
        null,
        0,
        null,
        null,
        entry.createdAt ?? new Date(),
      );
    }

    await trx.query(
      `INSERT INTO ${this.tableName}
        (id, event_type, event_version, event_kind, payload,
         aggregate_id, correlation_id, status, claimed_by, claimed_at,
         retry_count, last_error, published_at, created_at)
       VALUES ${valueGroups.join(', ')}`,
      params,
    );
  }

  async claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]> {
    const result = await this.pool.query<OutboxRow>(
      `WITH claimed AS (
         SELECT id FROM ${this.tableName}
         WHERE status = 'PENDING'
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.tableName} t
       SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3
       FROM claimed c
       WHERE t.id = c.id
       RETURNING t.*`,
      [batchSize, instanceId, new Date()],
    );
    return result.rows.map((r) => this.rowToEntry(r));
  }

  async markSent(id: string, publishedAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.tableName}
       SET status = 'SENT', published_at = $1, claimed_by = NULL, claimed_at = NULL
       WHERE id = $2`,
      [publishedAt, id],
    );
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${this.tableName}
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
      `UPDATE ${this.tableName}
       SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL
       WHERE status = 'CLAIMED' AND claimed_at < $1`,
      [olderThan],
    );
    return result.rowCount ?? 0;
  }

  async cleanup(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    const limit = options?.limit;
    const result = limit
      ? await this.pool.query(
          `WITH cte AS (
             SELECT id FROM ${this.tableName}
             WHERE status = 'SENT' AND published_at < $1
             ORDER BY published_at ASC
             LIMIT $2
           )
           DELETE FROM ${this.tableName} t
           USING cte
           WHERE t.id = cte.id`,
          [olderThan, limit],
        )
      : await this.pool.query(
          `DELETE FROM ${this.tableName}
           WHERE status = 'SENT' AND published_at < $1`,
          [olderThan],
        );
    return result.rowCount ?? 0;
  }

  private rowToEntry(row: OutboxRow): LocalOutboxEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventKind: row.event_kind,
      payload: row.payload,
      ...(row.aggregate_id !== null ? { aggregateId: row.aggregate_id } : {}),
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      status: row.status,
      ...(row.claimed_by !== null ? { claimedBy: row.claimed_by } : {}),
      ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
      retryCount: row.retry_count,
      ...(row.last_error !== null ? { lastError: row.last_error } : {}),
      ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
      createdAt: row.created_at,
    };
  }
}
