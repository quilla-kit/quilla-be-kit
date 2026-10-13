# @quilla-be-kit/jobs

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
