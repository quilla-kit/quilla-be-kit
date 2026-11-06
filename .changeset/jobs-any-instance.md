---
'@quilla-be-kit/jobs': minor
---

Run a job on any one instance per interval, pass an abort signal to every run, and add interval jitter.

- `runOn: { instances: 'any', leaseMs? }` on `BackgroundJob`: each interval, any one instance of the deployment runs the job and the others skip. Coordination goes through a `JobLeaseStore` passed to `InProcessJobRunner` (`leaseStore`, plus optional `instanceId` and `leaseMs`, default 60 s). The default, `{ instances: 'all' }`, keeps today's behaviour and never touches a store.
- New `@quilla-be-kit/jobs/postgres` sub-path: `PgJobLeaseStore` (on `pg.Pool`, optional `pg` peer) and `getJobLeaseSchema()` for your migrations. `InMemoryJobLeaseStore` ships in the root export for tests and single-process use.
- `JobLeaseManager.run(jobName, { cooldownMs, leaseMs?, signal? }, fn)` gives custom `JobRunner` implementations the same acquire → renew → release cycle. `JobLeaseLostError` (code `JOB_LEASE_LOST`) is the abort reason on lease loss.
- `execute(signal: AbortSignal)`: the signal aborts on `stop()`/`dispose()` and, for `'any'` jobs, when the lease is lost. Jobs written as `execute()` still satisfy the interface.
- `schedule.jitterMs`: each run after the first starts at a random 0..jitterMs offset from its slot. Not allowed on `'any'` jobs.
- Runs sit on a fixed grid anchored on the first run, instead of `setInterval`: no drift, missed slots are skipped rather than caught up, and a clock stepped back no longer stalls a job.

Upgrade notes:

- Code that calls `execute` through a `BackgroundJob` reference (custom runners, test helpers, "run now" endpoints) must now pass an `AbortSignal`.
- A custom `JobRunner` that ignores `runOn` runs `'any'` jobs on every instance; throw at `register` instead, or use `JobLeaseManager`.
- `register` now rejects an `everyMs` that is not a finite number above 0, and an `everyMs` or `initialDelayMs` above 2147483647. These values used to run every millisecond.
