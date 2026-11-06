---
'@quilla-be-kit/persistence': patch
---

README: correct the `onLocked: 'wait'` note. `InProcessJobRunner` skips a tick while the previous run is still executing, so concurrent sweepers come from other replicas, and a jobs `'any'` job runs on one instance per interval.
