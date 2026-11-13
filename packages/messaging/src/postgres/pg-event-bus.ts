import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import type { ClaimOptions } from '../event-bus/claim-options.type.js';
import { DEFAULT_LEASE_MS } from '../event-bus/defaults.js';
import type { EventBusConsumer } from '../event-bus/event-bus-consumer.interface.js';
import type { EventBusEntry } from '../event-bus/event-bus-entry.type.js';
import type { EventBusPublisher } from '../event-bus/event-bus-publisher.interface.js';
import type {
  ClearHandlerOutcomesOptions,
  HandlerOutcomeStore,
} from '../event-bus/handler-outcome-store.interface.js';
import type { MarkFailedOptions } from '../event-bus/mark-failed-options.type.js';
import { CLEAR_FAILURE, ClaimDao, RELEASE_CLAIM } from './claim.dao.js';
import { type EventsRow, toEventBusEntry } from './events.mapper.js';
import { PgDeliveryQueue } from './pg-delivery.queue.js';

const DEFAULT_EVENTS_TABLE = 'events';
const DEFAULT_DELIVERIES_TABLE = 'event_deliveries';
// One attempt plus one retry per DEFAULT_RETRY_DELAYS_MS step.
const DEFAULT_MAX_RETRIES = 4;

export type PgEventBusReplayOptions = ClearHandlerOutcomesOptions & {
  /** Clears the replayed events' handler outcomes, so their failed handlers run again. */
  readonly handlerOutcomes?: HandlerOutcomeStore;
};

export type PgEventBusOptions = {
  readonly pool: Pool;
  readonly eventsTableName?: string;
  readonly maxRetries?: number;
  readonly leaseMs?: number;
  /** Offers per-subscriber deliveries, for consumers with `isolation`. */
  readonly deliveries?: boolean;
  readonly deliveriesTableName?: string;
};

export class PgEventBus implements EventBusPublisher, EventBusConsumer {
  private readonly pool: Pool;
  private readonly eventsTable: string;
  private readonly maxRetries: number;
  readonly lease: ClaimLease;
  readonly deliveries?: PgDeliveryQueue;
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
    if (options.deliveries) {
      this.deliveries = new PgDeliveryQueue({
        pool: this.pool,
        table: options.deliveriesTableName ?? DEFAULT_DELIVERIES_TABLE,
        eventsTable: this.eventsTable,
        leaseMs: this.claims.durationMs,
      });
    }
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
    options?: ClaimOptions,
  ): Promise<readonly EventBusEntry[]> {
    const rows = await this.claims.claim<EventsRow>(instanceId, batchSize, allowedTopics, options);
    return rows.map((r) => toEventBusEntry(r));
  }

  markDone(id: string, instanceId?: string): Promise<void> {
    return this.claims.deleteOwned(id, instanceId);
  }

  async markFailed(
    id: string,
    reason: string,
    instanceId?: string,
    options?: MarkFailedOptions,
  ): Promise<EventBusEntry | undefined> {
    const row = await this.claims.markFailed<EventsRow>(
      id,
      reason,
      this.maxRetries,
      instanceId,
      options,
    );
    return row && toEventBusEntry(row);
  }

  async markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<EventBusEntry | undefined> {
    // A retry budget of 0 dead-letters on this attempt.
    const row = await this.claims.markFailed<EventsRow>(id, reason, 0, instanceId);
    return row && toEventBusEntry(row);
  }

  resetStale(olderThan: Date): Promise<number> {
    return this.claims.resetStale(olderThan);
  }

  /**
   * Returns FAILED rows to PENDING with a fresh retry budget; other rows are left alone.
   * Resolves to the ids replayed. `last_error` is kept until the next failure.
   */
  async replay(
    ids: readonly string[],
    options?: PgEventBusReplayOptions,
  ): Promise<readonly string[]> {
    let targets = ids;
    const store = options?.handlerOutcomes;
    if (store && targets.length > 0) {
      const { rows } = await this.claims.query<{ id: string }>(
        `SELECT id FROM ${this.eventsTable} WHERE id = ANY($1) AND status = 'FAILED'`,
        [[...targets]],
      );
      targets = rows.map((r) => r.id);
      // Cleared before the reset: consumers never claim a FAILED row, so none sees stale marks.
      if (targets.length > 0) {
        await store.clear(targets, { includeDone: options?.includeDone ?? false });
      }
    }
    if (targets.length === 0) return [];
    const { rows } = await this.claims.query<{ id: string }>(
      `UPDATE ${this.eventsTable}
       SET status = 'PENDING', retry_count = 0, ${CLEAR_FAILURE}, ${RELEASE_CLAIM}
       WHERE id = ANY($1) AND status = 'FAILED'
       RETURNING id`,
      [[...targets]],
    );
    return rows.map((r) => r.id);
  }

  cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.cleanupFailed(olderThan, options?.limit);
  }
}
