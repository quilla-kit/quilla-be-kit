import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  JobLease,
  JobLeaseAcquireRequest,
  JobLeaseReleaseRequest,
  JobLeaseRenewRequest,
  JobLeaseStore,
} from '../job-lease-store.interface.js';
import { DEFAULT_JOB_LEASE_TABLE } from './get-job-lease-schema.js';

export type PgJobLeaseStoreOptions = {
  readonly pool: Pool;
  readonly table?: string | undefined;
};

function msFromNow(param: number): string {
  return `now() + $${param}::double precision * interval '1 millisecond'`;
}

// Every comparison and stamp uses the database clock, so replicas with skewed clocks agree.
export class PgJobLeaseStore implements JobLeaseStore {
  private readonly pool: Pool;
  private readonly table: string;

  constructor(options: PgJobLeaseStoreOptions) {
    this.pool = options.pool;
    this.table = options.table ?? DEFAULT_JOB_LEASE_TABLE;
  }

  async tryAcquire(request: JobLeaseAcquireRequest): Promise<JobLease | null> {
    const token = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO ${this.table} AS t (job_name, claimed_by, lease_token, lease_expires_at, cooldown_until)
       VALUES ($1, $2, $3, ${msFromNow(4)}, ${msFromNow(5)})
       ON CONFLICT (job_name) DO UPDATE SET
         claimed_by = EXCLUDED.claimed_by,
         lease_token = EXCLUDED.lease_token,
         lease_expires_at = EXCLUDED.lease_expires_at,
         cooldown_until = EXCLUDED.cooldown_until
       WHERE (t.lease_token IS NULL OR t.lease_expires_at <= now()) AND t.cooldown_until <= now()
       RETURNING lease_token`,
      [request.jobName, request.instanceId, token, request.leaseMs, request.cooldownMs],
    );
    return result.rows.length > 0 ? { token } : null;
  }

  async renew(request: JobLeaseRenewRequest): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.table}
       SET lease_expires_at = ${msFromNow(3)}
       WHERE job_name = $1 AND lease_token = $2
       RETURNING job_name`,
      [request.jobName, request.token, request.leaseMs],
    );
    return result.rows.length > 0;
  }

  async release(request: JobLeaseReleaseRequest): Promise<void> {
    const resetCooldown = request.resetCooldown ? ', cooldown_until = now()' : '';
    await this.pool.query(
      `UPDATE ${this.table}
       SET claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL${resetCooldown}
       WHERE job_name = $1 AND lease_token = $2`,
      [request.jobName, request.token],
    );
  }
}
