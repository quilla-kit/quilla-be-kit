import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { ClaimLostError } from '../event-bus/claim-lost.error.js';
import type { ClaimOptions } from '../event-bus/claim-options.type.js';
import type {
  DeliveryBacklog,
  DeliveryEntry,
  DeliveryLane,
  DeliveryMove,
  DeliveryPair,
  NewDelivery,
  RekeyResult,
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
  member: string;
  queued_at: Date;
  event_seq: string | null;
  holds_lane: boolean | null;
};

// No delivery was queued when `id` is null.
type SettledRow = DeliveryRow & { settled: number };

/**
 * `retrying`: queued after a failed attempt. `held`: dead-lettered, holding its lane. `dead`:
 * dead-lettered, holding nothing.
 */
export type DeliveryState = 'retrying' | 'held' | 'dead';

export type DeliveryListOptions = {
  readonly handlerKey?: string;
  readonly member?: string;
  /** Default: every undrained delivery, queued, retrying or dead. */
  readonly state?: DeliveryState;
  /** Only deliveries with at least this many failed attempts. */
  readonly minAttempts?: number;
  /** Default 100. */
  readonly limit?: number;
};

/** A delivery with how many deliveries of its lane wait behind it. */
export type ListedDelivery = { readonly delivery: DeliveryEntry; readonly waiting: number };

// Column predicates; prefix with a table alias as `d.${HELD}`.
const HELD = 'holds_lane IS TRUE';
const QUEUED = "status IN ('PENDING', 'CLAIMED')";

const STATES: Record<DeliveryState, string> = {
  retrying: `d.${QUEUED} AND d.retry_count > 0`,
  held: `d.status = 'FAILED' AND d.${HELD}`,
  dead: `d.status = 'FAILED' AND NOT (d.${HELD})`,
};

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

// What blocks `e` within its lane: an earlier delivery of another event that is waiting for its
// retry (or, in verify, any earlier PENDING one), or that is dead and holds the lane.
// Deliveries of one event never wait for each other.
function earlierBlocker(o: string, e: string, pending: string): string {
  return `${sameLane(o, e)} AND ${o}.seq < ${e}.seq AND ${o}.event_id <> ${e}.event_id
          AND ((${o}.status = 'PENDING' AND ${pending}) OR (${o}.status = 'FAILED' AND ${o}.${HELD}))`;
}

export class PgDeliveryQueue implements DeliveryQueue {
  readonly lease: ClaimLease;
  private readonly table: string;
  private readonly eventsTable: string;
  private readonly claims: ClaimDao;

  constructor(options: PgDeliveryQueueOptions) {
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
           (id, event_id, consumer_name, handler_key, member, queued_at, event_type,
            event_version, event_kind, payload, source_service, aggregate_id, correlation_id,
            occurred_at, created_at, published_at, event_seq, status, retry_count, last_error,
            failed_at, last_failed_by, next_attempt_at, holds_lane)
         SELECT n.id, g.id, $3, n.handler_key, n.member, $4, g.event_type, g.event_version,
                g.event_kind, g.payload, g.source_service, g.aggregate_id, g.correlation_id,
                g.occurred_at, g.created_at, g.published_at, g.seq, n.status, n.retry_count,
                n.last_error, CASE WHEN n.status = 'FAILED' THEN $4::timestamptz END,
                n.last_failed_by, n.next_attempt_at,
                n.holds_lane AND n.status = 'FAILED' AND g.aggregate_id IS NOT NULL
         FROM gone g
         CROSS JOIN unnest($5::uuid[], $6::text[], $7::text[], $8::text[], $9::int[],
                           $10::text[], $11::text[], $12::timestamptz[], $13::boolean[])
           AS n(id, handler_key, member, status, retry_count, last_error, last_failed_by,
                next_attempt_at, holds_lane)
         ON CONFLICT (event_id, consumer_name, handler_key, member) DO NOTHING
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
        deliveries.map((d) => d.member),
        deliveries.map((d) => d.status),
        deliveries.map((d) => d.retryCount),
        deliveries.map((d) => d.lastError ?? null),
        deliveries.map((d) => d.lastFailedBy ?? null),
        deliveries.map((d) => d.nextAttemptAt ?? null),
        deliveries.map((d) => d.holdsLane ?? false),
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
       WHERE consumer_name = $1 AND aggregate_id = ANY($2)
         AND (${QUEUED} OR ${HELD})`,
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
    const members = pairs.map((p) => p.member);
    const types = pairs.map((p) => p.eventType);
    const params: unknown[] = [
      batchSize,
      instanceId,
      now,
      consumerName,
      keys,
      members,
      types,
      this.claims.expiryFrom(now),
      failoverCutoff(now, options),
    ];
    const due = (alias: string) => dueBy(alias, 2, 3, 9);
    const busy = (d: string, keysParam: number, typesParam: number) =>
      `EXISTS (SELECT 1 FROM ${this.eventsTable} b
         WHERE b.aggregate_id = ${d}.aggregate_id AND b.status = 'CLAIMED'
           AND b.event_type IN (SELECT p.t FROM unnest($${keysParam}::text[], $${typesParam}::text[]) AS p(k, t)
                                WHERE p.k = ${d}.handler_key))`;
    const claimSql = `WITH claimed AS (
         SELECT id FROM ${this.table} e
         WHERE e.status = 'PENDING' AND e.consumer_name = $4
           AND (e.handler_key, e.member) IN (SELECT * FROM unnest($5::text[], $6::text[]))
           AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ${due('e')})
           AND (e.aggregate_id IS NULL OR (
             NOT EXISTS (
               SELECT 1 FROM ${this.table} w
               WHERE ${earlierBlocker('w', 'e', `w.next_attempt_at > ${due('w')}`)}
             )
             AND NOT EXISTS (
               SELECT 1 FROM ${this.table} c WHERE ${sameLane('c', 'e')} AND c.status = 'CLAIMED'
             )
             AND NOT ${busy('e', 5, 7)}
             AND pg_try_advisory_xact_lock(hashtext('${this.table}'),
                   hashtext(concat_ws(E'\\x1f', e.consumer_name, e.aggregate_id, e.handler_key)))
           ))
         ORDER BY e.seq
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), updated AS (
         UPDATE ${this.table} t
         SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3, lease_expires_at = $8
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
             OR EXISTS (SELECT 1 FROM ${this.table} o WHERE ${earlierBlocker('o', 't', 'true')})
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
    options?: { readonly holdLane?: boolean },
  ): Promise<DeliveryEntry | undefined> {
    const params: unknown[] = [
      reason,
      id,
      new Date(),
      instanceId ?? null,
      options?.holdLane ?? false,
    ];
    const owned = this.claims.ownedBy(params, instanceId);
    const result = await this.claims.query<DeliveryRow>(
      `UPDATE ${this.table}
       SET retry_count = retry_count + 1,
           last_error = $1,
           status = 'FAILED',
           failed_at = $3,
           last_failed_by = $4,
           next_attempt_at = NULL,
           holds_lane = $5 AND aggregate_id IS NOT NULL,
           ${RELEASE_CLAIM}
       WHERE id = $2${owned}
       RETURNING *`,
      params,
    );
    this.claims.assertOwned(result, id, instanceId);
    const row = result.rows[0];
    return row && toDeliveryEntry(row);
  }

  // Serialized per consumer by an advisory lock, so replicas starting together move each row
  // once. Per event and target, the row furthest from done wins; the rest are superseded.
  async rekey(consumerName: string, moves: readonly DeliveryMove[]): Promise<RekeyResult> {
    if (moves.length === 0) return { moved: 0, superseded: 0 };
    return this.claims.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('${this.table}'), hashtext($1))`, [
        consumerName,
      ]);
      const { rows } = await client.query<{ moved: number; superseded: number }>(
        `WITH moves AS (
           SELECT * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS m(fk, fm, tk, tm)
         ), candidates AS (
           SELECT d.id, m.tk, m.tm,
                  row_number() OVER (
                    PARTITION BY d.event_id, m.tk, m.tm
                    ORDER BY CASE WHEN d.status = 'CLAIMED' THEN 0
                                  WHEN d.status = 'PENDING' THEN 1
                                  WHEN d.${HELD} THEN 2 ELSE 3 END, d.seq
                  ) AS rank,
                  EXISTS (SELECT 1 FROM ${this.table} x
                          WHERE x.event_id = d.event_id AND x.consumer_name = d.consumer_name
                            AND x.handler_key = m.tk AND x.member = m.tm) AS taken
           FROM ${this.table} d
           JOIN moves m ON d.handler_key = m.fk AND d.member = m.fm
           WHERE d.consumer_name = $1
         ), moved AS (
           UPDATE ${this.table} d SET handler_key = c.tk, member = c.tm
           FROM candidates c WHERE d.id = c.id AND c.rank = 1 AND NOT c.taken
           RETURNING d.id
         ), superseded AS (
           UPDATE ${this.table} d
           SET status = 'FAILED', last_error = 'rekey: superseded', failed_at = $6,
               holds_lane = false, next_attempt_at = NULL, ${RELEASE_CLAIM}
           FROM candidates c WHERE d.id = c.id AND (c.rank > 1 OR c.taken)
             AND (d.status <> 'FAILED' OR d.${HELD})
           RETURNING d.id
         )
         SELECT (SELECT count(*) FROM moved)::int AS moved,
                (SELECT count(*) FROM superseded)::int AS superseded`,
        [
          consumerName,
          moves.map((m) => m.from.key),
          moves.map((m) => m.from.member),
          moves.map((m) => m.to.key),
          moves.map((m) => m.to.member),
          new Date(),
        ],
      );
      return { moved: rows[0]?.moved ?? 0, superseded: rows[0]?.superseded ?? 0 };
    });
  }

  async backlog(consumerName: string): Promise<readonly DeliveryBacklog[]> {
    const { rows } = await this.claims.query<{
      handler_key: string;
      member: string;
      queued: number;
      held: number;
      lanes: number;
    }>(
      `SELECT handler_key, member,
              (count(*) FILTER (WHERE ${QUEUED}))::int AS queued,
              (count(*) FILTER (WHERE ${HELD}))::int AS held,
              (count(DISTINCT aggregate_id))::int AS lanes
       FROM ${this.table}
       WHERE consumer_name = $1 AND (${QUEUED} OR ${HELD})
       GROUP BY handler_key, member`,
      [consumerName],
    );
    return rows.map((r) => ({
      handlerKey: r.handler_key,
      member: r.member,
      queued: r.queued,
      held: r.held,
      lanes: r.lanes,
    }));
  }

  resetStale(olderThan: Date): Promise<number> {
    return this.claims.resetStale(olderThan);
  }

  /**
   * Returns FAILED deliveries to PENDING with a fresh budget, releasing any hold. A delivery
   * keeps its place in its lane, so a held one runs before the work queued behind it.
   */
  async replay(ids: readonly string[]): Promise<readonly DeliveryEntry[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.claims.query<DeliveryRow>(
      `UPDATE ${this.table}
       SET status = 'PENDING', retry_count = 0, queued_at = $2, holds_lane = false,
           ${CLEAR_FAILURE}, ${RELEASE_CLAIM}
       WHERE id = ANY($1) AND status = 'FAILED'
       RETURNING *`,
      [[...ids], new Date()],
    );
    return rows.map(toDeliveryEntry);
  }

  /** Lets the work behind held deliveries go on; they stay dead-lettered. */
  async releaseHold(ids: readonly string[]): Promise<readonly DeliveryEntry[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.claims.query<DeliveryRow>(
      `UPDATE ${this.table} SET holds_lane = false
       WHERE id = ANY($1) AND ${HELD}
       RETURNING *`,
      [[...ids]],
    );
    return rows.map(toDeliveryEntry);
  }

  /** Deliveries of `consumerName`, in queue order. */
  async list(
    consumerName: string,
    options: DeliveryListOptions = {},
  ): Promise<readonly ListedDelivery[]> {
    const { handlerKey, member, state, minAttempts, limit = 100 } = options;
    const params: unknown[] = [consumerName, limit];
    const where = ['d.consumer_name = $1'];
    const filter = (sql: string, value: unknown) => {
      params.push(value);
      where.push(`${sql} $${params.length}`);
    };
    if (handlerKey !== undefined) filter('d.handler_key =', handlerKey);
    if (member !== undefined) filter('d.member =', member);
    if (minAttempts !== undefined) filter('d.retry_count >=', minAttempts);
    if (state) where.push(STATES[state]);
    const { rows } = await this.claims.query<DeliveryRow & { waiting: number }>(
      `SELECT d.*,
              (SELECT count(*) FROM ${this.table} w
               WHERE ${sameLane('w', 'd')} AND w.seq > d.seq AND w.${QUEUED})::int AS waiting
       FROM ${this.table} d
       WHERE ${where.join(' AND ')}
       ORDER BY d.seq
       LIMIT $2`,
      params,
    );
    return rows.map((row) => ({ delivery: toDeliveryEntry(row), waiting: row.waiting }));
  }

  /** Deletes deliveries, whatever their status (e.g. queued work of a removed member). */
  async discard(ids: readonly string[]): Promise<readonly DeliveryEntry[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.claims.query<DeliveryRow>(
      `DELETE FROM ${this.table} WHERE id = ANY($1) RETURNING *`,
      [[...ids]],
    );
    return rows.map(toDeliveryEntry);
  }

  /** Deletes dead deliveries failed before `olderThan`, except those holding a lane. */
  cleanupFailed(olderThan: Date, options?: { readonly limit?: number }): Promise<number> {
    return this.claims.cleanupFailed(olderThan, options?.limit, HELD);
  }
}

// The entry carries the event's sequence, not the delivery's own queue position.
function toDeliveryEntry(row: DeliveryRow): DeliveryEntry {
  const { sequence: _ownSeq, ...entry } = toEventBusEntry(row);
  return {
    ...entry,
    ...(row.event_seq !== null ? { sequence: row.event_seq } : {}),
    eventId: row.event_id,
    consumerName: row.consumer_name,
    handlerKey: row.handler_key,
    member: row.member,
    queuedAt: row.queued_at,
    holdsLane: row.holds_lane === true,
  };
}
