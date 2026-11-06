import { randomUUID } from 'node:crypto';
import type {
  JobLease,
  JobLeaseAcquireRequest,
  JobLeaseReleaseRequest,
  JobLeaseRenewRequest,
  JobLeaseStore,
} from './job-lease-store.interface.js';

type LeaseRow = {
  token: string | null;
  leaseExpiresAt: number;
  cooldownUntil: number;
};

// Coordinates runners within one process only: for tests and single-instance deployments.
export class InMemoryJobLeaseStore implements JobLeaseStore {
  private readonly rows = new Map<string, LeaseRow>();

  async tryAcquire(request: JobLeaseAcquireRequest): Promise<JobLease | null> {
    const now = Date.now();
    const row = this.rows.get(request.jobName);
    if (row && ((row.token !== null && row.leaseExpiresAt > now) || row.cooldownUntil > now)) {
      return null;
    }
    const token = randomUUID();
    this.rows.set(request.jobName, {
      token,
      leaseExpiresAt: now + request.leaseMs,
      cooldownUntil: now + request.cooldownMs,
    });
    return { token };
  }

  async renew(request: JobLeaseRenewRequest): Promise<boolean> {
    const row = this.rows.get(request.jobName);
    if (!row || row.token !== request.token) return false;
    row.leaseExpiresAt = Date.now() + request.leaseMs;
    return true;
  }

  async release(request: JobLeaseReleaseRequest): Promise<void> {
    const row = this.rows.get(request.jobName);
    if (!row || row.token !== request.token) return;
    row.token = null;
    if (request.resetCooldown) row.cooldownUntil = Date.now();
  }
}
