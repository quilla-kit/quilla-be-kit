export type JobLease = {
  readonly token: string;
};

export type JobLeaseAcquireRequest = {
  readonly jobName: string;
  readonly instanceId: string;
  readonly leaseMs: number;
  readonly cooldownMs: number;
};

export type JobLeaseRenewRequest = {
  readonly jobName: string;
  readonly token: string;
  readonly leaseMs: number;
};

export type JobLeaseReleaseRequest = {
  readonly jobName: string;
  readonly token: string;
  /** Lets the job be acquired again right away; used when the lease was taken but the job never ran. */
  readonly resetCooldown?: boolean | undefined;
};

export interface JobLeaseStore {
  // One atomic conditional write: succeeds only when the job is unclaimed (or its lease expired)
  // and its cooldown has passed. Stamps a fresh token, the lease expiry and the cooldown.
  tryAcquire(request: JobLeaseAcquireRequest): Promise<JobLease | null>;
  // false once the job no longer carries this token.
  renew(request: JobLeaseRenewRequest): Promise<boolean>;
  // Token-checked. Keeps the cooldown unless `resetCooldown`.
  release(request: JobLeaseReleaseRequest): Promise<void>;
}
