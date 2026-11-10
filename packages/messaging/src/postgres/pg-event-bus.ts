import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { DEFAULT_LEASE_MS } from '../event-bus/defaults.js';
import type { EventBusConsumer } from '../event-bus/event-bus-consumer.interface.js';
import type { EventBusEntry, EventBusStatus } from '../event-bus/event-bus-entry.type.js';
import type { EventBusPublisher } from '../event-bus/event-bus-publisher.interface.js';
import { ClaimDao } from './claim.dao.js';

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
  origin_event_id: string | null;
  status: EventBusStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  failed_at: Date | null;
  seq: string | null;
  retry_count: number;
  last_error: string | null;
  created_at: Date;
  published_at: Date;
  occurred_at: Date;
};

export type PgEventBusOptions = {
  readonly pool: Pool;
  readonly eventsTableName?: string;
  readonly maxRetries?: number;
  readonly leaseMs?: number;
};
export class PgEventBus implements EventBusPublisher, EventBusConsumer {
  private readonly pool: Pool;
  private readonly eventsTable: string;
  private readonly maxRetries: number;
  readonly lease: ClaimLease;
  private readonly claims: ClaimDao;

  constructor(options: PgEventBusOptions) {
    this.pool = options.pool;
    this.eventsTable = options.eventsTableName ?? DEFAULT_EVENTS_TABLE;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.claims = new ClaimDao({
      pool: this.pool,
      table: this.eventsTable,
      durationMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      lockScope: 'aggregate',
    });
    this.lease = this.claims;
  }

  async publish(
    event: Parameters<EventBusPublisher['publish']>[0],
  ): Promise<{ id: string; inserted: boolean }> {
    const id = randomUUID();
    const publishedAt = new Date();
    const result = await this.claims.query<{ id: string }>(
      `INSERT INTO ${this.eventsTable}
         (id, event_type, event_version, event_kind, payload, source_service,
          aggregate_id, correlation_id, origin_event_id, status, claimed_by, claimed_at,
          retry_count, last_error, created_at, published_at, occurred_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (origin_event_id) WHERE origin_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        id,
        event.eventType,
        event.eventVersion,
        event.eventKind,
        JSON.stringify(event.payload),
        event.sourceService,
        event.aggregateId ?? null,
        event.correlationId ?? null,
        event.originEventId ?? null,
        'PENDING',
        null,
        null,
        0,
        null,
        event.createdAt,
        publishedAt,
        event.occurredAt,
        null,
      ],
    );
    if (result.rows.length > 0) {
      return { id, inserted: true };
    }
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id FROM ${this.eventsTable} WHERE origin_event_id = $1`,
      [event.originEventId],
    );
    const existingId = existing.rows[0]?.id;
    if (!existingId) {
      throw new Error(
        `publish: ON CONFLICT skipped insert but no existing row found for origin_event_id=${event.originEventId}`,
      );
    }
    return { id: existingId, inserted: false };
  }

  async claim(
    instanceId: string,
    batchSize: number,
    allowedTopics?: readonly string[],
  ): Promise<readonly EventBusEntry[]> {
    const rows = await this.claims.claim<EventsRow>(instanceId, batchSize, allowedTopics);
    return rows.map((r) => this.rowToEntry(r));
  }

  async markDone(id: string, instanceId?: string): Promise<void> {
    const params: unknown[] = [id];
    const owned = this.claims.ownedBy(params, instanceId);
    const result = await this.claims.query(
      `DELETE FROM ${this.eventsTable} WHERE id = $1${owned}`,
      params,
    );
    this.claims.assertOwned(result, id, instanceId);
  }

  async markFailed(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<EventBusEntry | undefined> {
    const row = await this.claims.markFailed<EventsRow>(id, reason, this.maxRetries, instanceId);
    return row && this.rowToEntry(row);
  }

  async markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<EventBusEntry | undefined> {
    // A retry budget of 0 dead-letters on this attempt.
    const row = await this.claims.markFailed<EventsRow>(id, reason, 0, instanceId);
    return row && this.rowToEntry(row);
  }

  resetStale(olderThan: Date): Promise<number> {
    return this.claims.resetStale(olderThan);
  }

  cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.cleanupFailed(olderThan, options?.limit);
  }

  private rowToEntry(row: EventsRow): EventBusEntry {
    return {
      id: row.id,
      eventType: row.event_type,
      eventVersion: row.event_version,
      eventKind: row.event_kind,
      payload: row.payload,
      sourceService: row.source_service,
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
      createdAt: row.created_at,
      publishedAt: row.published_at,
    };
  }
}
