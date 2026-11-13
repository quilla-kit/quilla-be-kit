import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { ClaimLostError } from '../event-bus/claim-lost.error.js';
import type { ClaimOptions } from '../event-bus/claim-options.type.js';
import type {
  DeliveryEntry,
  DeliveryLane,
  DeliveryPair,
  NewDelivery,
} from '../event-bus/delivery-entry.type.js';
import type { DeliveryQueue } from '../event-bus/delivery-queue.interface.js';
import type { MarkFailedOptions } from '../event-bus/mark-failed-options.type.js';
import { CLEAR_FAILURE, ClaimDao, RELEASE_CLAIM, dueBy, failoverCutoff } from './claim.dao.js';
import { type EventsRow, toEventBusEntry } from './events.mapper.js';
import { withColumnHint } from './missing-column.error.js';

type DeliveryRow = Omit<EventsRow, 'origin_event_id'> & {
  event_id: string;
  consumer_name: string;
  handler_key: string;
  queued_at: Date;
};

// No delivery was queued when `id` is null.
type SettledRow = DeliveryRow & { settled: number };

// The consumer applies the subscriber's budget and dead-letters with markFailedPermanently.
const NO_ATTEMPT_CAP = 2_147_483_647;

export type PgDeliveryQueueOptions = {
  readonly pool: Pool;
  readonly table: string;
  readonly eventsTable: string;
  readonly leaseMs: number;
};

// Same lane as `e`: one subscriber's deliveries of one aggregate.
function sameLane(alias: string, e: string): string {
  return `${alias}.consumer_name = ${e}.consumer_name AND ${alias}.aggregate_id = ${e}.aggregate_id AND ${alias}.handler_key = ${e}.handler_key`;
}

export class PgDeliveryQueue implements DeliveryQueue {
  readonly lease: ClaimLease;
  private readonly pool: Pool;
  private readonly table: string;
  private readonly eventsTable: string;
  private readonly claims: ClaimDao;

  constructor(options: PgDeliveryQueueOptions) {
    this.pool = options.pool;
    this.table = options.table;
    this.eventsTable = options.eventsTable;
    this.claims = new ClaimDao({
      pool: options.pool,
      table: options.table,
      durationMs: options.leaseMs,
      lockScope: 'table',
    });
    this.lease = this.claims;
  }

  // One statement, so atomic: `settled` = 0 means the event wasn't ours to settle.
  async settle(
    eventId: string,
    consumerName: string,
    deliveries: readonly NewDelivery[],
    instanceId: string,
  ): Promise<readonly DeliveryEntry[]> {
    const { rows } = await this.claims.query<SettledRow>(
      `WITH gone AS (
         DELETE FROM ${this.eventsTable}
         WHERE id = $1 AND (claimed_by = $2 OR claimed_by IS NULL)
         RETURNING *
       ), queued AS (
         INSERT INTO ${this.table}
           (id, event_id, consumer_name, handler_key, queued_at, event_type, event_version,
            event_kind, payload, source_service, aggregate_id, correlation_id, occurred_at,
            created_at, published_at, status, retry_count, last_error, failed_at,
            last_failed_by, next_attempt_at)
         SELECT n.id, g.id, $3, n.handler_key, $4, g.event_type, g.event_version, g.event_kind,
                g.payload, g.source_service, g.aggregate_id, g.correlation_id, g.occurred_at,
                g.created_at, g.published_at, n.status, n.retry_count, n.last_error,
                CASE WHEN n.status = 'FAILED' THEN $4::timestamptz END,
                n.last_failed_by, n.next_attempt_at
         FROM gone g
         CROSS JOIN unnest($5::uuid[], $6::text[], $7::text[], $8::int[], $9::text[],
                           $10::text[], $11::timestamptz[])
           AS n(id, handler_key, status, retry_count, last_error, last_failed_by, next_attempt_at)
         ON CONFLICT (event_id, consumer_name, handler_key) DO NOTHING
         RETURNING *
       )
       SELECT (SELECT count(*) FROM gone)::int AS settled, q.*
       FROM (SELECT 1) AS one LEFT JOIN queued q ON true`,
      [
        eventId,
        instanceId,
        consumerName,
        new Date(),
        deliveries.map(() => randomUUID()),
        deliveries.map((d) => d.handlerKey),
        deliveries.map((d) => d.status),
        deliveries.map((d) => d.retryCount),
        deliveries.map((d) => d.lastError ?? null),
        deliveries.map((d) => d.lastFailedBy ?? null),
        deliveries.map((d) => d.nextAttemptAt ?? null),
      ],
    );
    if (rows[0]?.settled !== 1) throw new ClaimLostError(eventId);
    return rows.flatMap((row) => (row.id === null ? [] : [toDeliveryEntry(row)]));
  }

  async openLanes(
    consumerName: string,
    aggregateIds: readonly string[],
  ): Promise<readonly DeliveryLane[]> {
    if (aggregateIds.length === 0) return [];
    const { rows } = await this.claims.query<{ handler_key: string; aggregate_id: string }>(
      `SELECT DISTINCT handler_key, aggregate_id FROM ${this.table}
       WHERE consumer_name = $1 AND aggregate_id = ANY($2) AND status IN ('PENDING', 'CLAIMED')`,
      [consumerName, [...aggregateIds]],
    );
    return rows.map((r) => ({ handlerKey: r.handler_key, aggregateId: r.aggregate_id }));
  }

  // As the bus claim (ClaimDao.claim), per lane. The busy-event guard keeps a delivery from
  // running while its subscriber may be running an event of the same aggregate directly; the
  // two tables lock separately, so verify re-checks it on a fresh snapshot.
  async claim(
    instanceId: string,
    batchSize: number,
    consumerName: string,
    pairs: readonly DeliveryPair[],
    options?: ClaimOptions,
  ): Promise<readonly DeliveryEntry[]> {
    if (pairs.length === 0) return [];
    const now = new Date();
    const keys = pairs.map((p) => p.key);
    const types = pairs.map((p) => p.eventType);
    const params: unknown[] = [
      batchSize,
      instanceId,
      now,
      consumerName,
      keys,
      types,
      this.claims.expiryFrom(now),
      failoverCutoff(now, options),
    ];
    const due = (alias: string) => dueBy(alias, 2, 3, 8);
    const busy = (d: string, keysParam: number, typesParam: number) =>
      `EXISTS (SELECT 1 FROM ${this.eventsTable} b
         WHERE b.aggregate_id = ${d}.aggregate_id AND b.status = 'CLAIMED'
           AND b.event_type IN (SELECT p.t FROM unnest($${keysParam}::text[], $${typesParam}::text[]) AS p(k, t)
                                WHERE p.k = ${d}.handler_key))`;
    const claimSql = `WITH claimed AS (
         SELECT id FROM ${this.table} e
         WHERE e.status = 'PENDING' AND e.consumer_name = $4
           AND (e.handler_key, e.event_type) IN (SELECT * FROM unnest($5::text[], $6::text[]))
           AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ${due('e')})
           AND (e.aggregate_id IS NULL OR (
             NOT EXISTS (
               SELECT 1 FROM ${this.table} w
               WHERE ${sameLane('w', 'e')} AND w.status = 'PENDING'
                 AND w.next_attempt_at > ${due('w')} AND w.seq < e.seq
             )
             AND NOT EXISTS (
               SELECT 1 FROM ${this.table} c WHERE ${sameLane('c', 'e')} AND c.status = 'CLAIMED'
             )
             AND NOT ${busy('e', 5, 6)}
             AND pg_try_advisory_xact_lock(hashtext('${this.table}'),
                   hashtext(concat_ws(E'\\x1f', e.consumer_name, e.aggregate_id, e.handler_key)))
           ))
         ORDER BY e.seq
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), updated AS (
         UPDATE ${this.table} t
         SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3, lease_expires_at = $7
         FROM claimed c
         WHERE t.id = c.id
         RETURNING t.*
       )
       SELECT * FROM updated ORDER BY seq`;

    return this.claims.transaction(async (client) => {
      const rows = (await withColumnHint(client.query<DeliveryRow>(claimSql, params), this.table))
        .rows;
      let kept = rows;
      if (rows.some((row) => row.aggregate_id !== null)) {
        const released = await client.query<{ id: string }>(
          `UPDATE ${this.table} t
           SET status = 'PENDING', ${RELEASE_CLAIM}
           WHERE t.id = ANY($1) AND t.aggregate_id IS NOT NULL AND (
             EXISTS (SELECT 1 FROM ${this.table} o
                     WHERE ${sameLane('o', 't')} AND o.status = 'CLAIMED' AND NOT (o.id = ANY($1)))
             OR EXISTS (SELECT 1 FROM ${this.table} o
                        WHERE ${sameLane('o', 't')} AND o.status = 'PENDING' AND o.seq < t.seq)
             OR ${busy('t', 2, 3)}
           )
           RETURNING t.id`,
          [rows.map((row) => row.id), keys, types],
        );
        const releasedIds = new Set(released.rows.map((row) => row.id));
        kept = rows.filter((row) => !releasedIds.has(row.id));
      }
      return kept.map(toDeliveryEntry);
    });
  }

  markDone(id: string, instanceId?: string): Promise<void> {
    return this.claims.deleteOwned(id, instanceId);
  }

  async markFailed(
    id: string,
    reason: string,
    instanceId?: string,
    options?: MarkFailedOptions,
  ): Promise<DeliveryEntry | undefined> {
    const row = await this.claims.markFailed<DeliveryRow>(
      id,
      reason,
      NO_ATTEMPT_CAP,
      instanceId,
      options,
    );
    return row && toDeliveryEntry(row);
  }

  async markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<DeliveryEntry | undefined> {
    const row = await this.claims.markFailed<DeliveryRow>(id, reason, 0, instanceId);
    return row && toDeliveryEntry(row);
  }

  // Skips a delivery whose event already has one under `to` (the unique key would reject it).
  async rekey(consumerName: string, from: readonly string[], to: string): Promise<number> {
    if (from.length === 0) return 0;
    const result = await this.claims.query(
      `UPDATE ${this.table} t SET handler_key = $3
       WHERE t.consumer_name = $1 AND t.handler_key = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM ${this.table} o
                         WHERE o.event_id = t.event_id AND o.consumer_name = t.consumer_name
                           AND o.handler_key = $3)`,
      [consumerName, [...from], to],
    );
    return result.rowCount ?? 0;
  }

  async countOrphans(consumerName: string, pairs: readonly DeliveryPair[]): Promise<number> {
    const { rows } = await this.claims.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${this.table}
       WHERE consumer_name = $1 AND status IN ('PENDING', 'CLAIMED')
         AND (handler_key, event_type) NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))`,
      [consumerName, pairs.map((p) => p.key), pairs.map((p) => p.eventType)],
    );
    return Number(rows[0]?.count ?? 0);
  }

  resetStale(olderThan: Date): Promise<number> {
    return this.claims.resetStale(olderThan);
  }

  async replay(ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.claims.query<{ id: string }>(
      `UPDATE ${this.table}
       SET status = 'PENDING', retry_count = 0, queued_at = $2, ${CLEAR_FAILURE}, ${RELEASE_CLAIM}
       WHERE id = ANY($1) AND status = 'FAILED'
       RETURNING id`,
      [[...ids], new Date()],
    );
    return rows.map((r) => r.id);
  }

  cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.cleanupFailed(olderThan, options?.limit);
  }
}

function toDeliveryEntry(row: DeliveryRow): DeliveryEntry {
  return {
    ...toEventBusEntry(row),
    eventId: row.event_id,
    consumerName: row.consumer_name,
    handlerKey: row.handler_key,
    queuedAt: row.queued_at,
  };
}
