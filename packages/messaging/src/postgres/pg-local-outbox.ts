import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { DEFAULT_LEASE_MS } from '../event-bus/defaults.js';
import type {
  LocalOutboxEntry,
  LocalOutboxInsertInput,
  LocalOutboxStatus,
} from '../local-outbox/local-outbox-entry.type.js';
import type { LocalOutboxReader } from '../local-outbox/local-outbox-reader.interface.js';
import type { LocalOutboxWriter } from '../local-outbox/local-outbox-writer.interface.js';
import type { TransactionHandle } from '../local-outbox/transaction-handle.interface.js';
import { ClaimDao, RELEASE_CLAIM } from './claim.dao.js';
import { withColumnHint } from './missing-column.error.js';

const DEFAULT_TABLE_NAME = 'outbox_events';
const DEFAULT_MAX_RETRIES = 3;
const INSERT_COLUMN_COUNT = 16;
// Postgres' bind message counts parameters in a 16-bit field.
const MAX_PARAMETERS = 65535;
const ENTRIES_PER_STATEMENT = Math.floor(MAX_PARAMETERS / INSERT_COLUMN_COUNT);

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
  lease_expires_at: Date | null;
  failed_at: Date | null;
  seq: string | null;
  retry_count: number;
  last_error: string | null;
  published_at: Date | null;
  created_at: Date;
  occurred_at: Date;
};

export type PgLocalOutboxOptions = {
  readonly pool: Pool;
  readonly tableName?: string;
  readonly maxRetries?: number;
  readonly leaseMs?: number;
};

export class PgLocalOutbox implements LocalOutboxWriter, LocalOutboxReader {
  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly maxRetries: number;
  readonly lease: ClaimLease;
  private readonly claims: ClaimDao;

  constructor(options: PgLocalOutboxOptions) {
    this.pool = options.pool;
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.claims = new ClaimDao({
      pool: this.pool,
      table: this.tableName,
      durationMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      lockScope: 'table',
    });
    this.lease = this.claims;
  }

  async insert(entries: readonly LocalOutboxInsertInput[], trx: TransactionHandle): Promise<void> {
    const statements: { sql: string; params: unknown[] }[] = [];
    for (let start = 0; start < entries.length; start += ENTRIES_PER_STATEMENT) {
      statements.push(this.insertStatement(entries.slice(start, start + ENTRIES_PER_STATEMENT)));
    }
    for (const { sql, params } of statements) {
      await withColumnHint(trx.query(sql, params), this.tableName);
    }
  }

  private insertStatement(entries: readonly LocalOutboxInsertInput[]): {
    sql: string;
    params: unknown[];
  } {
    const params: unknown[] = [];
    const valueGroups: string[] = [];

    for (const [i, entry] of entries.entries()) {
      const base = i * INSERT_COLUMN_COUNT;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, ` +
          `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
          `$${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, ` +
          `$${base + 16})`,
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
        entry.occurredAt,
        null,
      );
    }

    return {
      sql: `INSERT INTO ${this.tableName}
        (id, event_type, event_version, event_kind, payload,
         aggregate_id, correlation_id, status, claimed_by, claimed_at,
         retry_count, last_error, published_at, created_at, occurred_at, lease_expires_at)
       VALUES ${valueGroups.join(', ')}`,
      params,
    };
  }

  // Same per-aggregate guard as the bus, so one aggregate's entries are forwarded by one replica
  // at a time and reach the bus in seq order.
  async claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]> {
    const rows = await this.claims.claim<OutboxRow>(instanceId, batchSize);
    return rows.map((r) => this.rowToEntry(r));
  }

  async markSent(id: string, publishedAt: Date, instanceId?: string): Promise<void> {
    const params: unknown[] = [publishedAt, id];
    const owned = this.claims.ownedBy(params, instanceId);
    const result = await this.claims.query(
      `UPDATE ${this.tableName}
       SET status = 'SENT', published_at = $1, ${RELEASE_CLAIM}
       WHERE id = $2${owned}`,
      params,
    );
    this.claims.assertOwned(result, id, instanceId);
  }

  markFailed(id: string, reason: string, instanceId?: string): Promise<void> {
    return this.claims.markFailed(id, reason, this.maxRetries, instanceId);
  }

  resetStale(olderThan: Date): Promise<number> {
    return this.claims.resetStale(olderThan);
  }

  cleanup(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.deleteOlderThan('SENT', 'published_at', olderThan, options?.limit);
  }

  cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.cleanupFailed(olderThan, options?.limit);
  }

  private rowToEntry(row: OutboxRow): LocalOutboxEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventKind: row.event_kind,
      payload: row.payload,
      occurredAt: row.occurred_at,
      ...(row.aggregate_id !== null ? { aggregateId: row.aggregate_id } : {}),
      ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
      status: row.status,
      ...(row.claimed_by !== null ? { claimedBy: row.claimed_by } : {}),
      ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
      ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
      retryCount: row.retry_count,
      ...(row.last_error !== null ? { lastError: row.last_error } : {}),
      ...(row.failed_at !== null ? { failedAt: row.failed_at } : {}),
      ...(row.published_at !== null ? { publishedAt: row.published_at } : {}),
      createdAt: row.created_at,
    };
  }
}
