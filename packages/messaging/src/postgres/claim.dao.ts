import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { ClaimLostError } from '../event-bus/claim-lost.error.js';
import { withColumnHint } from './missing-column.error.js';

export const RELEASE_CLAIM = 'claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL';

export type ClaimDaoOptions = {
  readonly pool: Pool;
  readonly table: string;
  readonly durationMs: number;
  // 'aggregate' keeps the bus's pre-0.9.0 lock key so old and new consumers still exclude each
  // other; 'table' namespaces the key so outbox and bus claims on one database don't contend.
  readonly lockScope: 'aggregate' | 'table';
};

// Claim, completion and retention SQL shared by the bus and outbox tables (same claim columns).
export class ClaimDao implements ClaimLease {
  readonly durationMs: number;
  private readonly pool: Pool;
  private readonly table: string;
  private readonly lockKey: string;

  constructor(options: ClaimDaoOptions) {
    this.pool = options.pool;
    this.table = options.table;
    this.durationMs = options.durationMs;
    this.lockKey =
      options.lockScope === 'aggregate'
        ? 'hashtext(e.aggregate_id)::bigint'
        : `hashtext('${options.table}'), hashtext(e.aggregate_id)`;
  }

  expiryFrom(claimedAt: Date): Date {
    return new Date(claimedAt.getTime() + this.durationMs);
  }

  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult<R>> {
    return withColumnHint(this.pool.query<R>(sql, params), this.table);
  }

  // The claim statement reads one snapshot, and its advisory-lock filter runs per scanned row,
  // so it can take a later row of an aggregate while missing an earlier one (another claim held
  // the lock, then committed). Verify runs on a fresh snapshot in the same transaction and gives
  // back any row whose aggregate has a CLAIMED row, or an earlier PENDING row of `topics`,
  // outside the batch. The topic predicate is inlined (not `$4 IS NULL OR …`) so each variant
  // plans against its partial index.
  async claim<R extends QueryResultRow & { id: string; aggregate_id: string | null }>(
    instanceId: string,
    batchSize: number,
    topics?: readonly string[],
  ): Promise<R[]> {
    const now = new Date();
    const params: unknown[] = [batchSize, instanceId, now];
    const hasTopics = topics !== undefined && topics.length > 0;
    if (hasTopics) params.push([...topics]);
    params.push(this.expiryFrom(now));
    const claimSql = `WITH claimed AS (
         SELECT id FROM ${this.table} e
         WHERE e.status = 'PENDING'
           ${hasTopics ? 'AND e.event_type = ANY($4)' : ''}
           AND NOT EXISTS (
             SELECT 1 FROM ${this.table} e2
             WHERE e2.aggregate_id IS NOT NULL
               AND e2.aggregate_id = e.aggregate_id
               AND e2.status = 'CLAIMED'
           )
           AND (e.aggregate_id IS NULL OR pg_try_advisory_xact_lock(${this.lockKey}))
         ORDER BY e.seq NULLS FIRST, e.created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ), updated AS (
         UPDATE ${this.table} t
         SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3, lease_expires_at = $${params.length}
         FROM claimed c
         WHERE t.id = c.id
         RETURNING t.*
       )
       SELECT * FROM updated ORDER BY seq NULLS FIRST, created_at`;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = (await withColumnHint(client.query<R>(claimSql, params), this.table)).rows;
      let kept = rows;
      if (rows.some((row) => row.aggregate_id !== null)) {
        const ids = rows.map((row) => row.id);
        const pendingTopic = hasTopics ? 'AND o.event_type = ANY($2)' : '';
        const released = await client.query<{ id: string }>(
          `UPDATE ${this.table} t
           SET status = 'PENDING', ${RELEASE_CLAIM}
           WHERE t.id = ANY($1) AND t.aggregate_id IS NOT NULL AND (
             EXISTS (SELECT 1 FROM ${this.table} o
                     WHERE o.aggregate_id = t.aggregate_id AND o.status = 'CLAIMED'
                       AND NOT (o.id = ANY($1)))
             OR EXISTS (SELECT 1 FROM ${this.table} o
                        WHERE o.aggregate_id = t.aggregate_id AND o.status = 'PENDING' ${pendingTopic}
                          AND o.seq < t.seq)
             OR EXISTS (SELECT 1 FROM ${this.table} o
                        WHERE o.aggregate_id = t.aggregate_id AND o.status = 'PENDING' ${pendingTopic}
                          AND o.seq IS NULL AND (t.seq IS NOT NULL OR o.created_at < t.created_at))
           )
           RETURNING t.id`,
          hasTopics ? [ids, [...topics]] : [ids],
        );
        const releasedIds = new Set(released.rows.map((row) => row.id));
        kept = rows.filter((row) => !releasedIds.has(row.id));
      }
      await client.query('COMMIT');
      return kept;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Appends the owner param and returns its predicate; empty when the caller isn't fencing.
  ownedBy(params: unknown[], instanceId: string | undefined): string {
    if (instanceId === undefined) return '';
    params.push(instanceId);
    return ` AND (claimed_by = $${params.length} OR claimed_by IS NULL)`;
  }

  assertOwned(result: QueryResult, id: string, instanceId: string | undefined): void {
    if (instanceId !== undefined && (result.rowCount ?? 0) === 0) throw new ClaimLostError(id);
  }

  async markFailed(
    id: string,
    reason: string,
    maxRetries: number,
    instanceId: string | undefined,
  ): Promise<void> {
    const params: unknown[] = [reason, id, maxRetries, new Date()];
    const owned = this.ownedBy(params, instanceId);
    const result = await this.query(
      `UPDATE ${this.table}
       SET retry_count = retry_count + 1,
           last_error = $1,
           status = CASE WHEN retry_count + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END,
           failed_at = CASE WHEN retry_count + 1 >= $3 THEN $4::timestamptz ELSE NULL END,
           ${RELEASE_CLAIM}
       WHERE id = $2${owned}`,
      params,
    );
    this.assertOwned(result, id, instanceId);
  }

  // Rows with no failed_at (failed before 0.9.0) have an unknown age and are kept.
  cleanupFailed(olderThan: Date, limit: number | undefined): Promise<number> {
    return this.deleteOlderThan('FAILED', 'failed_at', olderThan, limit);
  }

  async deleteOlderThan(
    status: 'FAILED' | 'SENT',
    column: 'failed_at' | 'published_at',
    olderThan: Date,
    limit: number | undefined,
  ): Promise<number> {
    const result = limit
      ? await this.query(
          `WITH cte AS (
             SELECT id FROM ${this.table}
             WHERE status = '${status}' AND ${column} < $1
             ORDER BY ${column} ASC
             LIMIT $2
           )
           DELETE FROM ${this.table} t
           USING cte
           WHERE t.id = cte.id`,
          [olderThan, limit],
        )
      : await this.query(
          `DELETE FROM ${this.table} WHERE status = '${status}' AND ${column} < $1`,
          [olderThan],
        );
    return result.rowCount ?? 0;
  }

  // claimed_at moves with the lease so older versions' claimed_at-based sweep spares live claims.
  async renew(instanceId: string, ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) return [];
    const now = new Date();
    const result = await this.query<{ id: string }>(
      `UPDATE ${this.table}
       SET claimed_at = $3, lease_expires_at = $4
       WHERE id = ANY($1) AND claimed_by = $2 AND status = 'CLAIMED'
       RETURNING id`,
      [[...ids], instanceId, now, this.expiryFrom(now)],
    );
    return result.rows.map((r) => r.id);
  }

  // A lease counts only when written with the current claim (lease > claimed_at); NULL or
  // leftover leases come from claims by versions that don't write leases, and use the cutoff.
  async resetStale(olderThan: Date): Promise<number> {
    const result = await this.query(
      `UPDATE ${this.table}
       SET status = 'PENDING', ${RELEASE_CLAIM}
       WHERE status = 'CLAIMED' AND (
         (lease_expires_at > claimed_at AND lease_expires_at < $2)
         OR ((lease_expires_at IS NULL OR lease_expires_at <= claimed_at) AND claimed_at < $1)
       )`,
      [olderThan, new Date()],
    );
    return result.rowCount ?? 0;
  }
}
