# @quilla-be-kit/jobs

## 0.5.0

### Minor Changes

- 599429f: Cross between scopes under an app-owned policy, and read the execution context from event handlers, jobs and routes through one `getContext()` view.

  **execution-context**

  - `provider.crossScope(scopeId, fn)` runs `fn` in the current context moved to another scope. It adds or joins a scope like `withScope`. Moving from one scope to another requires a `ScopeCrossingPolicy` (`authorize`, optional `projectContext`), passed as `scopeCrossing` on `AsyncExecutionContextProvider` (a function returning it is resolved on first use). The kit keeps `actorType`, `correlationId`, `executionAttemptId` and the session's `userId`, drops every other field by default, and records the origin scope in the new `ExecutionContext.crossedFrom`. Custom `ExecutionContextProvider` implementations must add `crossScope` (`crossExecutionContext` builds its context) and must keep `executionAttemptId` in `withScope` and `crossScope`. A custom `ExecutionContextFactory` should extend the default `createFromEventMetadata` result so `crossedFrom` keeps round-tripping.
  - `toEventMetadataSource(ctx, { actorAttributeKeys })` builds the event metadata a context should stamp, the inverse of `createFromEventMetadata`, which now also restores `crossedFrom`.
  - `ExecutionContextView` (+ scoped and session variants) and `toExecutionContextView(ctx)`.
  - `requireScopeId(ctx)` / `requireSession(ctx)` / `requireContext(ctx, 'scope' | 'session')`, throwing `MissingScopeError` / `MissingSessionError` (`InternalError`s, matched across duplicate installs with `.is(err)`). The package now depends on `@quilla-be-kit/errors`.
  - `readAttemptContext(provider, attemptId)` returns the current context only while it belongs to that execution attempt.
  - The log enricher adds `extra.crossedFrom`.

  **ddd**

  - `EventMetadata` gains an optional `crossedFrom` (requires `scopeId`, must differ from it; omitted from JSON when absent). `RESERVED_ACTOR_ATTRIBUTE_KEYS` is exported.

  **messaging**

  - `HandlerEntry.getContext()` returns the live `ExecutionContextView`. It throws when the consumer has no `executionContext`, when called outside the handler's dispatch, or when the context no longer meets the handler's requirement. Entries built by hand (test fixtures) must add it: use `createHandlerEntry(fields, view)`.
  - Handlers declare `requires: 'scope' | 'session'` (`on(..., { requires })`, `ScopedEventSubscription`, `SessionEventSubscription`) for a narrowed entry type. Every requirement is checked before an event's handlers run; if one is unmet, none runs and the row is marked failed without in-process retries. Declaring a requirement without `executionContext` throws at registration.
  - README: validation failures are redelivered until `maxRetries` like any failure, not marked `FAILED` directly.

  **jobs**

  - `BackgroundJob.execute(signal, execution)`: `execution.getContext()` and `execution.forEachScope(entries, fn)`, which runs `fn` once per scope in `withScope`, isolates and logs failures, and skips the remaining scopes once aborted. Jobs implementing `execute(signal)` still type-check; calls through the `BackgroundJob` type pass both arguments. Custom runners build the argument with `createJobExecution(...)`.

  **http**

  - `HttpRequest.getContext()` returns the live `ExecutionContextView`. Custom `HttpRequest` implementations must add it. `getExecutionContext()` is deprecated in its favour.

  **persistence**

  - README example reads the scope with `req.getContext()`.

### Patch Changes

- Updated dependencies [599429f]
  - @quilla-be-kit/execution-context@0.6.0

## 0.4.0

### Minor Changes

- 2b9119d: Run a job on any one instance per interval, pass an abort signal to every run, and add interval jitter.

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

## 0.3.0

### Minor Changes

- 5054ac1: `InProcessJobRunner` no longer runs a job alongside itself: a tick that fires while the job's previous run is still executing is skipped and logged at `debug`. This fixes `drain()`, which could stop waiting on an earlier run once an overlapping run replaced it in the runner's tracking. The guarantee is per process.

  Interval schedules accept `initialDelayMs?: number`, the delay before the first run (default `everyMs`). `0` runs the job right after `register` returns, through the same path as every tick (fresh `job` context, overlap skip, error logging, `drain()` tracking). A negative or non-finite value throws at `register`.

  - **Custom `JobRunner` authors:** honor `initialDelayMs`, or throw at `register` on schedules you can't honor.

### Patch Changes

- Updated dependencies [5054ac1]
  - @quilla-be-kit/execution-context@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [c073429]
  - @quilla-be-kit/execution-context@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [603c3af]
  - @quilla-be-kit/execution-context@0.3.0
  - @quilla-be-kit/observability@0.3.0

## 0.2.2

### Patch Changes

- 77153bc: Document `InProcessJobRunner` error handling: errors thrown inside `execute()` are caught, logged at `error` level, and do not crash the runner or affect other registered jobs.
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
  - @quilla-be-kit/execution-context@0.2.2
  - @quilla-be-kit/observability@0.2.2
  - @quilla-be-kit/runtime@0.2.2

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages
- Updated dependencies [30c8333]
  - @quilla-be-kit/execution-context@0.2.1
  - @quilla-be-kit/observability@0.2.1
  - @quilla-be-kit/runtime@0.2.1

## 0.2.0

### Minor Changes

- 59526ba: Initial surface for `@quilla-be-kit/jobs`: `BackgroundJob` and `JobRunner`
  contracts, `JobSchedule` union (interval-only for now), and
  `InProcessJobRunner` — a timer-based reference runner that runs every tick
  inside a system `ExecutionContext` and implements `Disposable` from
  `@quilla-be-kit/runtime`.

### Patch Changes

- Updated dependencies [8c8e6af]
- Updated dependencies [f1dfa83]
- Updated dependencies [2bd37fe]
- Updated dependencies [45b7c58]
- Updated dependencies [7c86c48]
- Updated dependencies [7c86c48]
  - @quilla-be-kit/execution-context@0.2.0
  - @quilla-be-kit/observability@0.2.0
  - @quilla-be-kit/runtime@0.2.0
