# @quilla-be-kit/jobs

Background-job contracts and an in-process runner for substrate-grade
TypeScript services. Register scheduled jobs, run each tick inside a system
execution context, run a job on any one instance of a deployment, shut down
cleanly via `Disposable`.

```sh
pnpm add @quilla-be-kit/jobs
```

Node 22+, ESM-only.

---

## What's in the box

| Export | What it is |
| --- | --- |
| `BackgroundJob` | Interface your jobs implement — `name`, `schedule`, `runOn?`, `execute(signal, execution)` |
| `JobExecution` | Second argument of `execute` — `getContext()` and `forEachScope(...)` |
| `ScopeRunResult` | What `forEachScope` resolves to — `succeeded`, `failed`, `skipped` |
| `createJobExecution` | Builds the `JobExecution` a custom runner passes to `execute` |
| `JobSchedule` / `JobScheduleType` | Schedule union + type constants |
| `JobRunOn` / `JobInstances` | Where a job runs — `'all'` instances (default) or `'any'` one instance |
| `JobRunner` | Runner contract — `register`, `stop`, `drain`, `dispose` |
| `InProcessJobRunner` | Reference implementation — timer-based, one per process |
| `JobLeaseStore` | Contract for the store that coordinates `'any'` jobs across instances |
| `InMemoryJobLeaseStore` | Store for tests and single-process deployments |
| `JobLeaseManager` | Acquire → renew → release around one run; the building block for custom runners |
| `JobLeaseLostError` | Abort reason when an `'any'` job's lease is lost |

`@quilla-be-kit/jobs/postgres`:

| Export | What it is |
| --- | --- |
| `PgJobLeaseStore` | `JobLeaseStore` on Postgres (`pg.Pool`) |
| `getJobLeaseSchema` | DDL for the lease table, to capture in your migrations |

Zero external runtime deps. Depends on `@quilla-be-kit/errors`,
`@quilla-be-kit/execution-context`, `@quilla-be-kit/observability`, and
`@quilla-be-kit/runtime`. `pg` is an optional peer dependency, needed only for
`@quilla-be-kit/jobs/postgres`.

---

## Usage

```ts
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { StructuredLoggerFactory } from '@quilla-be-kit/observability';
import {
  type BackgroundJob,
  InProcessJobRunner,
  JobScheduleType,
} from '@quilla-be-kit/jobs';

class HeartbeatJob implements BackgroundJob {
  readonly name = 'infra.Heartbeat';
  readonly schedule = { type: JobScheduleType.Interval, everyMs: 30_000 };

  async execute(): Promise<void> {
    // do work — runs inside a system ExecutionContext (actorType: 'job')
  }
}

const provider = new AsyncExecutionContextProvider();
const logger = /* your Logger */;
const runner = new InProcessJobRunner(provider, logger);

runner.register(new HeartbeatJob());
```

On shutdown:

```ts
await runner.dispose(); // stops timers, aborts in-flight signals, awaits in-flight ticks
```

`InProcessJobRunner` implements `Disposable` from `@quilla-be-kit/runtime`, so you
can register it directly with your `Runtime` and it will be drained as part
of normal shutdown.

### `stop()` / `drain()` / `dispose()`

The `JobRunner` contract exposes three distinct lifecycle hooks:

- **`stop()`** — idempotent; stops accepting new ticks and aborts the signal
  of every in-flight run. Does **not** wait for them. Returns synchronously.
  Jobs registered after `stop()` are scheduled again.
- **`drain()`** — async; awaits every in-flight tick to complete. Safe to
  call after `stop()`; a no-op if nothing is running. Each job has at most
  one run in flight (see [Overlapping runs](#overlapping-runs)), so there is
  never an untracked run to miss.
- **`dispose()`** — the shutdown-phase convenience: calls `stop()` then
  `drain()` and returns when everything has settled. This is what you
  register with `Runtime` / `ShutdownManager`.

Split `stop()` + `drain()` when you need to stop accepting work *before*
initiating the wait (e.g., drain from multiple runners in parallel with
one combined `Promise.all(runners.map(r => r.drain()))`).

---

## Execution context

Every tick runs inside
`executionContextProvider.runWithContext(ctx, fn)` where `ctx` is a fresh
system context (`actorType: 'job'`, new `correlationId`). Any downstream code
that reads `provider.getContext()` will see it — including the logger
enricher, repository scope checks, event publishers, etc.

If `execute()` throws, `InProcessJobRunner` catches the error, logs it at
`error` level, and continues scheduling future ticks. A failing job does not
crash the runner or affect other registered jobs.

`execute(signal, execution)` also receives a `JobExecution`:

- `execution.getContext()` — the run's `ExecutionContextView` (see
  `@quilla-be-kit/execution-context`), read live: inside a `withScope` or a
  `forEachScope` callback it reports that scope. It throws once the run is
  over.
- `execution.forEachScope(entries, fn)` — runs `fn(value, scopeId)` once per
  `[scopeId, value]` entry (a `Map` works), one after another, each in
  `withScope(scopeId)` so its unit of work, events and logs carry that scope.
  A failing scope is logged with its `scopeId` and recorded; the others still
  run. Once the signal aborts, the remaining scopes are recorded as skipped,
  without error logs. It rejects if the context already has a scope — call it
  from the job's own context, not inside another `withScope`.

```ts
async execute(signal: AbortSignal, execution: JobExecution): Promise<void> {
  const byScope = groupBy(await this.invitations.findExpired(), (i) => i.scopeId);
  const { failed } = await execution.forEachScope(byScope, (invitations) =>
    this.uow.transaction(async (ctx) => {
      // one transaction per scope
    }),
  );
  if (failed.length > 0) this.metrics.increment('expire-invitations.scope-failed', failed.length);
}
```

Pass `{ onScopeFailed }` to replace the default failure log, for example to
keep a descriptive message and your own fields:

```ts
await execution.forEachScope(byScope, (invitations) => this.expire(invitations), {
  onScopeFailed: (error, scopeId, invitations, { aborted }) => {
    if (aborted) return;
    log.error('expire-invitations-failed', error, { meta: { scopeId, count: invitations.length } });
  },
});
```

It runs for every failure, including an error thrown after the run was
aborted (`aborted: true`; that scope is still recorded as skipped), and the
kit then logs nothing itself. It runs in the job's own context, not the
failing scope's, so `scopeId` and the value identify the scope. It may be
async; a throw or rejection is logged and the loop continues.

`forEachScope` resolves to a `ScopeRunResult<R>`:

| Field | Holds |
| --- | --- |
| `succeeded` | `{ scopeId, value }` for each scope whose `fn` resolved, in order |
| `failed` | `{ scopeId, error }` for each scope whose `fn` threw (already logged) |
| `skipped` | scope ids not run, or interrupted, because the signal aborted |

A custom `JobRunner` builds the argument with
`createJobExecution({ provider, context, logger, signal })`, called inside the
context it established for the run, with that `context`; `logger` receives
the per-scope failure logs.

---

## Abort signal

`execute(signal)` receives an `AbortSignal`. It aborts when:

- the runner stops (`stop()` / `dispose()`) — every job;
- the lease is lost — `'any'` jobs only (see below). `signal.reason` is then a
  `JobLeaseLostError`.

A job that ignores the signal keeps running until it returns, exactly as
before. A long pass checks it between units of work:

```ts
import { JobLeaseLostError } from '@quilla-be-kit/jobs';

async execute(signal: AbortSignal): Promise<void> {
  for (const batch of await this.findBatches()) {
    if (signal.aborted) {
      if (JobLeaseLostError.is(signal.reason)) this.logger.warn('lease lost, stopping');
      return;
    }
    await this.process(batch, { signal });
  }
}
```

Jobs written as `execute()` or `execute(signal)` still satisfy `BackgroundJob`.
Code that calls `execute` through the `BackgroundJob` type passes both
arguments.

---

## Overlapping runs

`InProcessJobRunner` never runs a job alongside itself in the same process.
When a tick fires while the job's previous run is still executing, the tick
is skipped and logged at `debug` (`Skipping <name>: previous run still in
progress`); the next tick runs as normal once the previous run settles.

A job that wants parallelism manages it inside `execute()` (for example,
claim N rows and process them concurrently). If ticks are skipped
constantly, `everyMs` is shorter than the job's run time.

The guarantee is per process. By default, replicas that register the same
job each run it on their own timer, so jobs that run on several replicas
still claim their work atomically (e.g. `SELECT … FOR UPDATE SKIP LOCKED`).
To run a job on one instance per interval instead, see the next section.

---

## Running on any one instance

By default a job runs on **every** instance that registers it
(`runOn: { instances: 'all' }`). That is what you want for work local to the
process (refreshing an in-memory cache, flushing per-process buffers) and for
claim-based workers, where each replica takes a different slice.

A job that repeats the **same full pass** on every replica — a sweep over
storage, a report, a reconciliation — sets `runOn: { instances: 'any' }`. Each
interval, any one instance runs it and the others skip:

```ts
import { InProcessJobRunner, JobInstances, JobScheduleType, type BackgroundJob } from '@quilla-be-kit/jobs';
import { PgJobLeaseStore } from '@quilla-be-kit/jobs/postgres';

class ReindexJob implements BackgroundJob {
  readonly name = 'search.Reindex';
  readonly schedule = { type: JobScheduleType.Interval, everyMs: 10 * 60_000 };
  readonly runOn = { instances: JobInstances.Any };

  async execute(signal: AbortSignal): Promise<void> {
    // one instance per interval; stop early when signal aborts
  }
}

const runner = new InProcessJobRunner(provider, logger, {
  leaseStore: new PgJobLeaseStore({ pool: leasePool }),
});
runner.register(new ReindexJob());
```

The lease table ships as DDL to capture in your migrations:

```ts
import { getJobLeaseSchema } from '@quilla-be-kit/jobs/postgres';

await db.query(getJobLeaseSchema()); // or { table: 'billing_job_leases' }
```

### How it works

On each tick of an `'any'` job, the runner asks the store for the job's
lease — one conditional write to a single row. The write succeeds only when
no live lease is held **and** the job's cooldown has passed. The cooldown is
stamped at acquire (slightly under `everyMs`), so whichever instance fires
first after it takes the run, and every other instance skips (logged at
`debug`). Jobs with `instances: 'all'` never touch the store.

While the run executes, the lease is renewed every `leaseMs / 3`, and
released when the run ends. All times come from the database clock, so
replicas with skewed clocks agree.

- **No instance is pinned.** The holder usually keeps winning while it is
  alive; another instance takes over when it dies, stops, or can't reach the
  store.
- **Cost:** one acquire query per tick per replica, plus renewals while a run
  is in progress.
- **Takeover:** after a holder dies mid-run, the next instance to fire runs
  the job once its lease and cooldown have passed. When the holder changes,
  the gap between runs is between `everyMs` and about `2 × everyMs`.
- **`leaseMs`** (default 60 s; set it on the runner, or per job with
  `runOn: { instances: 'any', leaseMs }`) is how fast a dead holder is
  detected, not a bound on how long a run may take — live runs keep renewing.
- `'any'` jobs need `everyMs >= 1000` and don't accept `jitterMs`.

### Guarantees and caveats

- **One holder per interval, not exactly-once.** A holder that dies mid-run
  leaves its work partly done for the next run. A run that ignores its signal
  after losing the lease can overlap the new holder. Keep claiming work
  atomically and keep it idempotent.
- **When the lease can't be renewed** (taken over, or not confirmed in time)
  the run's signal aborts with `JobLeaseLostError` one renewal interval before
  the lease expires.
- **Store outage:** `'any'` jobs pause on every instance — they never run
  without a lease. `'all'` jobs are unaffected. One `error` is logged when the
  store becomes unreachable and one `info` when it recovers.
- **Renewal runs on a timer and on the store's pool.** CPU-bound synchronous
  work blocks the timer, and an exhausted pool delays the query; either can
  let a lease lapse before the signal fires. Give the store a small dedicated
  pool.
- **Job names must be unique per lease table.** Services sharing a database
  use separate tables (`table` option).
- With `initialDelayMs: 0`, the startup run is skipped when the previous
  deployment's cooldown hasn't elapsed yet.
- During a rolling upgrade, replicas on versions without `runOn` keep running
  the job every tick.

### Custom runners and stores

`JobLeaseManager` wraps one run in acquire → renew → release, so a custom
`JobRunner` gets the same guarantees:

```ts
import { JobLeaseManager, createJobExecution } from '@quilla-be-kit/jobs';

const leases = new JobLeaseManager({ store, logger }); // optional: instanceId, leaseMs

async function onTick(job: BackgroundJob): Promise<void> {
  const controller = new AbortController(); // one per run; abort it to stop the run
  const ran = await leases.run(job.name, { cooldownMs: 55_000, signal: controller.signal }, (signal) =>
    job.execute(
      signal,
      createJobExecution({ provider, context: provider.getContext(), logger, signal }),
    ),
  );
  // ran === false: held by another instance or not due yet
}
```

`run` resolves `false` without calling the function when the lease isn't
acquired, always releases the lease, and rejects when the store is
unavailable.

A `JobLeaseStore` implementation (Redis, a Kubernetes Lease, an existing
leader election…) must provide:

- **`tryAcquire`** — one atomic conditional write: succeeds only when the job
  has no live lease and its cooldown has passed; stamps a fresh token, the
  lease expiry and the cooldown.
- **`renew` / `release`** — checked against the token; a stale token is a
  no-op (`renew` resolves `false`).
- **`release`** keeps the cooldown, unless `resetCooldown` is set (the lease
  was taken but the job never ran).

`cooldownMs: 0` turns the lease into a plain "one at a time" lock.

---

## Schedule types

Only `interval` is supported today. The schedule union is extensible — add
`cron`, `once`, or `manual` variants when a runner actually implements them,
rather than shipping placeholder types a consumer can't trust. The
`InProcessJobRunner` throws at `register` time on unknown schedule types so
additions are a loud, explicit choice.

### `interval`

| Field | Meaning |
| --- | --- |
| `everyMs` | Time between runs. A finite number above 0, at most 2147483647 (the timer limit). |
| `initialDelayMs` | Optional. Delay before the first run; defaults to `everyMs`. `0` runs the job right after `register` returns (never synchronously inside it). The interval is anchored on the first run. |
| `jitterMs` | Optional. Each run after the first starts up to `jitterMs` later than its slot, at random, so instances running the same job don't fire in lockstep. Below `everyMs`. Not allowed on `'any'` jobs. |

```ts
// Runs once at startup, then every minute.
readonly schedule = { type: JobScheduleType.Interval, everyMs: 60_000, initialDelayMs: 0 };

// Staggered: first run 10s after startup, then every minute.
readonly schedule = { type: JobScheduleType.Interval, everyMs: 60_000, initialDelayMs: 10_000 };

// Every minute, each run spread over the first 5s of its slot.
readonly schedule = { type: JobScheduleType.Interval, everyMs: 60_000, jitterMs: 5_000 };
```

Runs sit on a fixed grid from the first run, so they don't drift. A slot
missed while the event loop was blocked (or the clock jumped forward) is
skipped, not caught up; when the clock steps back, the grid restarts from the
current time rather than stalling.

The first run goes through the same path as every tick: a fresh `job`
context, the overlap skip, error logging, and tracking for `drain()`. A
`stop()` before it fires cancels it. Out-of-range values throw at `register`.

A custom `JobRunner` must honor every `JobSchedule` field and `runOn`, and
pass an `AbortSignal` to `execute`, or throw at `register` on jobs it can't
honor.

---

## What this package is **not**

- Not a distributed scheduler. `'any'` jobs coordinate through a lease, one
  holder per interval, but there is no cluster-wide clock, no exactly-once
  delivery and no work partitioning between instances.
- Not a cron runtime. `interval` only, for now.
- Not a persistent queue. In-process timers, lost on restart.

For cron or persistent-queue semantics, implement `JobRunner`
against your preferred scheduler (Temporal, cloud schedulers, etc.) — the
interface is the stable contract, and `JobLeaseManager` provides the lease.

---

## License

MIT — © Max Martinez.
