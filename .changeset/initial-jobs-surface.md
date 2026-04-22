---
'@quilla-kit/jobs': minor
---

Initial surface for `@quilla-kit/jobs`: `BackgroundJob` and `JobRunner`
contracts, `JobSchedule` union (interval-only for now), and
`InProcessJobRunner` — a timer-based reference runner that runs every tick
inside a system `ExecutionContext` and implements `Disposable` from
`@quilla-kit/runtime`.
