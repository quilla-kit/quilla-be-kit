import { randomUUID } from 'node:crypto';
import type { Logger } from '@quilla-be-kit/observability';
import { JobLeaseLostError } from './job-lease-lost.error.js';
import type { JobLease, JobLeaseStore } from './job-lease-store.interface.js';

const DEFAULT_JOB_LEASE_MS = 60_000;

export type JobLeaseManagerOptions = {
  readonly store: JobLeaseStore;
  readonly logger: Logger;
  /** Recorded as the lease holder; defaults to a random UUID. */
  readonly instanceId?: string | undefined;
  /** How long a dead holder keeps a job before another instance can take it. Defaults to 60 s. */
  readonly leaseMs?: number | undefined;
};

export type JobLeaseRunOptions = {
  /** After this run's acquire, no other acquire of the job succeeds for this long. */
  readonly cooldownMs: number;
  readonly leaseMs?: number | undefined;
  /** Aborting it stops the run: no acquire once aborted, and the run's signal aborts with it. */
  readonly signal?: AbortSignal | undefined;
};

export function assertLeaseMs(leaseMs: number, owner: string, jobName?: string): void {
  if (Number.isFinite(leaseMs) && leaseMs >= 3) return;
  const job = jobName === undefined ? '' : ` (job "${jobName}")`;
  throw new Error(`${owner} requires leaseMs to be a finite number >= 3${job}`);
}

// Logs one error when the store becomes unavailable and one info when it recovers.
class TrackedStore {
  private unavailable = false;

  constructor(
    private readonly store: JobLeaseStore,
    private readonly logger: Logger,
  ) {}

  async call<T>(call: (store: JobLeaseStore) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await call(this.store);
    } catch (err) {
      if (this.unavailable) {
        this.logger.debug('lease store still unavailable');
      } else {
        this.unavailable = true;
        this.logger.error('lease store unavailable', err);
      }
      throw err;
    }
    if (this.unavailable) {
      this.unavailable = false;
      this.logger.info('lease store recovered');
    }
    return result;
  }
}

// Renews one acquired lease until `finish`. Every tick checks the deadline before anything else,
// so a renew that hangs can't keep the run going past its lease.
class HeldLease {
  private readonly controller = new AbortController();
  private readonly renewIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewing = false;
  private settled = false;

  constructor(
    private readonly store: TrackedStore,
    private readonly logger: Logger,
    private readonly jobName: string,
    private readonly lease: JobLease,
    private readonly leaseMs: number,
    private confirmedAt: number,
  ) {
    this.renewIntervalMs = Math.floor(leaseMs / 3);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.expiring()) return;
    this.timer = setInterval(() => this.tick(), this.renewIntervalMs);
  }

  async finish(resetCooldown: boolean): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    this.stopTimer();
    const { jobName, lease } = this;
    try {
      await this.store.call((s) => s.release({ jobName, token: lease.token, resetCooldown }));
    } catch {
      // Logged by the tracker; the lease expires on its own.
    }
  }

  private tick(): void {
    if (this.settled || this.expiring() || this.renewing) return;
    void this.renew();
  }

  private async renew(): Promise<void> {
    this.renewing = true;
    const { jobName, lease, leaseMs } = this;
    // The store stamps the expiry when the statement runs, so confirm from the send time.
    const sentAt = Date.now();
    try {
      const held = await this.store.call((s) => s.renew({ jobName, token: lease.token, leaseMs }));
      if (this.settled) return;
      if (held) this.confirmedAt = Math.max(this.confirmedAt, sentAt);
      else this.lose();
    } catch {
      // Logged by the tracker; the deadline check gives up if renewals keep failing.
    } finally {
      this.renewing = false;
    }
  }

  // Gives up one renew interval before expiry, while no other instance can have taken over yet.
  private expiring(): boolean {
    if (Date.now() + this.renewIntervalMs < this.confirmedAt + this.leaseMs) return false;
    this.lose();
    return true;
  }

  private lose(): void {
    if (this.settled || this.controller.signal.aborted) return;
    this.stopTimer();
    this.logger.warn('job lease lost; aborting the run', { meta: { jobName: this.jobName } });
    this.controller.abort(new JobLeaseLostError(this.jobName));
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export class JobLeaseManager {
  private readonly store: TrackedStore;
  private readonly logger: Logger;
  private readonly instanceId: string;
  private readonly leaseMs: number;

  constructor(options: JobLeaseManagerOptions) {
    this.leaseMs = options.leaseMs ?? DEFAULT_JOB_LEASE_MS;
    assertLeaseMs(this.leaseMs, 'JobLeaseManager');
    this.store = new TrackedStore(options.store, options.logger);
    this.logger = options.logger;
    this.instanceId = options.instanceId ?? randomUUID();
  }

  // Resolves to true once `fn` ran under the lease, false when the lease wasn't acquired.
  // Rejects when the store is unavailable, and with whatever `fn` throws.
  async run(
    jobName: string,
    options: JobLeaseRunOptions,
    fn: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    const caller = options.signal;
    if (caller?.aborted) return false;
    const leaseMs = options.leaseMs ?? this.leaseMs;
    assertLeaseMs(leaseMs, 'JobLeaseManager', jobName);
    const { cooldownMs } = options;
    if (!(Number.isFinite(cooldownMs) && cooldownMs >= 0)) {
      throw new Error(
        `JobLeaseManager requires cooldownMs to be a finite number >= 0 (job "${jobName}")`,
      );
    }

    const sentAt = Date.now();
    const { instanceId } = this;
    const lease = await this.store.call((s) =>
      s.tryAcquire({ jobName, instanceId, leaseMs, cooldownMs }),
    );
    if (!lease) return false;

    const held = new HeldLease(this.store, this.logger, jobName, lease, leaseMs, sentAt);
    const signal = caller ? AbortSignal.any([caller, held.signal]) : held.signal;
    held.start();
    if (signal.aborted) {
      await held.finish(true);
      return false;
    }

    try {
      await fn(signal);
    } finally {
      await held.finish(false);
    }
    return true;
  }
}
