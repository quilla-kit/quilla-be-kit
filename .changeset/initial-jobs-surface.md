---
'@quilla-be-kit/jobs': minor
---

Initial surface for `@quilla-be-kit/jobs`: `BackgroundJob` and `JobRunner`
contracts, `JobSchedule` union (interval-only for now), and
`InProcessJobRunner` — a timer-based reference runner that runs every tick
inside a system `ExecutionContext` and implements `Disposable` from
`@quilla-be-kit/runtime`.
