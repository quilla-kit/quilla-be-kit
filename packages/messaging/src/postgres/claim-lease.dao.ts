import type { Pool, QueryResult, QueryResultRow } from 'pg';
import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import { ClaimLostError } from '../event-bus/claim-lost.error.js';
import { withLeaseColumnHint } from './missing-lease-column.error.js';

export class ClaimLeaseDao implements ClaimLease {
  readonly durationMs: number;
  private readonly pool: Pool;
  private readonly table: string;

  constructor(pool: Pool, table: string, durationMs: number) {
    this.pool = pool;
    this.table = table;
    this.durationMs = durationMs;
  }

  expiryFrom(claimedAt: Date): Date {
    return new Date(claimedAt.getTime() + this.durationMs);
  }

  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[],
  ): Promise<QueryResult<R>> {
    return withLeaseColumnHint(this.pool.query<R>(sql, params), this.table);
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
       SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL
       WHERE status = 'CLAIMED' AND (
         (lease_expires_at > claimed_at AND lease_expires_at < $2)
         OR ((lease_expires_at IS NULL OR lease_expires_at <= claimed_at) AND claimed_at < $1)
       )`,
      [olderThan, new Date()],
    );
    return result.rowCount ?? 0;
  }
}
