import { beforeEach, describe, expect, it } from 'vitest';
import { PgJobLeaseStore } from '../../src/postgres/pg-job-lease.store.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('PgJobLeaseStore', () => {
  let pool: FakePgPool;
  let store: PgJobLeaseStore;

  beforeEach(() => {
    pool = new FakePgPool();
    store = new PgJobLeaseStore({ pool: pool.asPool() });
  });

  describe('tryAcquire', () => {
    const request = { jobName: 'job', instanceId: 'a', leaseMs: 3000, cooldownMs: 900 };

    it('is one conditional upsert on the database clock', async () => {
      await store.tryAcquire(request);
      const sql = squash(pool.lastCall().sql);

      expect(pool.calls).toHaveLength(1);
      expect(sql).toContain(
        'INSERT INTO job_leases AS t (job_name, claimed_by, lease_token, lease_expires_at, cooldown_until)',
      );
      expect(sql).toContain(
        "VALUES ($1, $2, $3, now() + $4::double precision * interval '1 millisecond', now() + $5::double precision * interval '1 millisecond')",
      );
      expect(sql).toContain('ON CONFLICT (job_name) DO UPDATE SET');
      expect(sql).toContain(
        'WHERE (t.lease_token IS NULL OR t.lease_expires_at <= now()) AND t.cooldown_until <= now()',
      );
      expect(sql).toContain('RETURNING lease_token');
    });

    it('passes a fresh token per acquire', async () => {
      await store.tryAcquire(request);
      await store.tryAcquire(request);
      const [first, second] = pool.calls.map((c) => c.params);

      expect(first?.slice(0, 2)).toEqual(['job', 'a']);
      expect(first?.slice(3)).toEqual([3000, 900]);
      expect(first?.[2]).toMatch(/^[0-9a-f-]{36}$/);
      expect(second?.[2]).not.toBe(first?.[2]);
    });

    it('returns the lease when a row comes back', async () => {
      pool.enqueue([{ lease_token: 'ignored' }]);
      const lease = await store.tryAcquire(request);
      expect(lease).toEqual({ token: pool.lastCall().params[2] });
    });

    it('returns null when the conditional update matched nothing', async () => {
      expect(await store.tryAcquire(request)).toBeNull();
    });
  });

  describe('renew', () => {
    it('extends the lease only while the token matches', async () => {
      pool.enqueue([{ job_name: 'job' }]);
      expect(await store.renew({ jobName: 'job', token: 't1', leaseMs: 3000 })).toBe(true);
      const { sql, params } = pool.lastCall();

      expect(squash(sql)).toBe(
        "UPDATE job_leases SET lease_expires_at = now() + $3::double precision * interval '1 millisecond' WHERE job_name = $1 AND lease_token = $2 RETURNING job_name",
      );
      expect(params).toEqual(['job', 't1', 3000]);
    });

    it('returns false when the token no longer matches', async () => {
      expect(await store.renew({ jobName: 'job', token: 't1', leaseMs: 3000 })).toBe(false);
    });
  });

  describe('release', () => {
    it('clears the claim and keeps the cooldown', async () => {
      await store.release({ jobName: 'job', token: 't1' });
      const { sql, params } = pool.lastCall();

      expect(squash(sql)).toBe(
        'UPDATE job_leases SET claimed_by = NULL, lease_token = NULL, lease_expires_at = NULL WHERE job_name = $1 AND lease_token = $2',
      );
      expect(params).toEqual(['job', 't1']);
    });

    it('resets the cooldown when asked', async () => {
      await store.release({ jobName: 'job', token: 't1', resetCooldown: true });
      expect(squash(pool.lastCall().sql)).toContain(
        'lease_expires_at = NULL, cooldown_until = now() WHERE',
      );
    });
  });

  it('honors a custom table', async () => {
    const custom = new PgJobLeaseStore({ pool: pool.asPool(), table: 'billing.job_leases' });
    await custom.tryAcquire({ jobName: 'job', instanceId: 'a', leaseMs: 3000, cooldownMs: 0 });
    await custom.renew({ jobName: 'job', token: 't', leaseMs: 3000 });
    await custom.release({ jobName: 'job', token: 't' });

    expect(pool.calls[0]?.sql).toContain('INSERT INTO billing.job_leases AS t');
    expect(pool.calls[1]?.sql).toContain('UPDATE billing.job_leases');
    expect(pool.calls[2]?.sql).toContain('UPDATE billing.job_leases');
  });
});
