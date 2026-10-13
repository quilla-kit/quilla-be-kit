# @quilla-be-kit/jobs

Background-job contracts and an in-process runner for substrate-grade
TypeScript services. Register scheduled jobs, run each tick inside a system
execution context, shut down cleanly via `Disposable`.

```sh
pnpm add @quilla-be-kit/jobs
```

Node 22+, ESM-only.

---

## What's in the box

| Export | What it is |
| --- | --- |
| `BackgroundJob` | Interface your jobs implement — `name`, `schedule`, `execute()` |
| `JobSchedule` / `JobScheduleType` | Schedule union + type constants |
| `JobRunner` | Runner contract — `register`, `stop`, `drain`, `dispose` |
| `InProcessJobRunner` | Reference implementation — timer-based, single-process |

Zero external runtime deps. Depends on `@quilla-be-kit/execution-context`,
`@quilla-be-kit/observability`, and `@quilla-be-kit/runtime`.

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
await runner.dispose(); // stops timers + awaits in-flight ticks
```

`InProcessJobRunner` implements `Disposable` from `@quilla-be-kit/runtime`, so you
can register it directly with your `Runtime` and it will be drained as part
of normal shutdown.

### `stop()` / `drain()` / `dispose()`

The `JobRunner` contract exposes three distinct lifecycle hooks:

- **`stop()`** — idempotent; stops accepting new ticks. Does **not** wait
  for in-flight executions. Returns synchronously.
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

---

## Overlapping runs

`InProcessJobRunner` never runs a job alongside itself in the same process.
When a tick fires while the job's previous run is still executing, the tick
is skipped and logged at `debug` (`Skipping <name>: previous run still in
progress`); the next tick runs as normal once the previous run settles.

A job that wants parallelism manages it inside `execute()` (for example,
claim N rows and process them concurrently). If ticks are skipped
constantly, `everyMs` is shorter than the job's run time.

The guarantee is per process. Replicas that register the same job each run
it on their own timer, so jobs that run on several replicas still claim
their work atomically (e.g. `SELECT … FOR UPDATE SKIP LOCKED`).

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
| `everyMs` | Time between runs. |
| `initialDelayMs` | Optional. Delay before the first run; defaults to `everyMs`. `0` runs the job right after `register` returns (never synchronously inside it). The interval is anchored on the first run. |

```ts
// Runs once at startup, then every minute.
readonly schedule = { type: JobScheduleType.Interval, everyMs: 60_000, initialDelayMs: 0 };

// Staggered: first run 10s after startup, then every minute.
readonly schedule = { type: JobScheduleType.Interval, everyMs: 60_000, initialDelayMs: 10_000 };
```

The first run goes through the same path as every tick: a fresh `job`
context, the overlap skip, error logging, and tracking for `drain()`. A
`stop()` before it fires cancels it. A negative or non-finite
`initialDelayMs` throws at `register`.

A custom `JobRunner` must honor every `JobSchedule` field, `initialDelayMs`
included, or throw at `register` on schedules it can't honor.

---

## What this package is **not**

- Not a distributed scheduler. Every replica that registers the same job
  runs it on its own timer — fine for idempotent tick-and-claim jobs
  (like an outbox forwarder that claims rows atomically), not fine for
  "run this exactly once per cluster per minute" jobs.
- Not a cron runtime. `interval` only, for now.
- Not a persistent queue. In-process timers, lost on restart.

For cluster-wide cron or persistent-queue semantics, implement `JobRunner`
against your preferred scheduler (Postgres-claimed locks, Redis, Temporal,
cloud schedulers, etc.) — the interface is the stable contract.

---

## License

MIT — © Max Martinez.
