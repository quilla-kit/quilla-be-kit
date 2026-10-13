---
"@quilla-be-kit/jobs": minor
---

`InProcessJobRunner` no longer runs a job alongside itself: a tick that fires while the job's previous run is still executing is skipped and logged at `debug`. This fixes `drain()`, which could stop waiting on an earlier run once an overlapping run replaced it in the runner's tracking. The guarantee is per process.

Interval schedules accept `initialDelayMs?: number`, the delay before the first run (default `everyMs`). `0` runs the job right after `register` returns, through the same path as every tick (fresh `job` context, overlap skip, error logging, `drain()` tracking). A negative or non-finite value throws at `register`.

- **Custom `JobRunner` authors:** honor `initialDelayMs`, or throw at `register` on schedules you can't honor.
