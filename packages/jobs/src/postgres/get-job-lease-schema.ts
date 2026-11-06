export const DEFAULT_JOB_LEASE_TABLE = 'job_leases';

export type JobLeaseSchemaOptions = {
  readonly table?: string | undefined;
};

export function getJobLeaseSchema(options?: JobLeaseSchemaOptions): string {
  const table = options?.table ?? DEFAULT_JOB_LEASE_TABLE;
  return `CREATE TABLE IF NOT EXISTS ${table} (
  job_name TEXT PRIMARY KEY,
  claimed_by TEXT,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  cooldown_until TIMESTAMPTZ NOT NULL
);`;
}
