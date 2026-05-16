# @quilla-be-kit/jobs

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
