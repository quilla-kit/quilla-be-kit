import { describe, expect, it } from 'vitest';
import { getJobLeaseSchema } from '../../src/postgres/get-job-lease-schema.js';

describe('getJobLeaseSchema', () => {
  it('creates the job_leases table by default', () => {
    const sql = getJobLeaseSchema();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS job_leases (');
    expect(sql).toContain('job_name TEXT PRIMARY KEY');
    expect(sql).toContain('claimed_by TEXT');
    expect(sql).toContain('lease_token UUID');
    expect(sql).toContain('lease_expires_at TIMESTAMPTZ');
    expect(sql).toContain('cooldown_until TIMESTAMPTZ NOT NULL');
  });

  it('declares no defaults', () => {
    expect(getJobLeaseSchema()).not.toMatch(/DEFAULT/i);
  });

  it('honors a custom table', () => {
    const sql = getJobLeaseSchema({ table: 'billing_job_leases' });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS billing_job_leases (');
    expect(sql).not.toContain('EXISTS job_leases');
  });
});
