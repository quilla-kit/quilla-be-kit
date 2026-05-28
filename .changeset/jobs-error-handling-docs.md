---
"@quilla-be-kit/jobs": patch
---

Document `InProcessJobRunner` error handling: errors thrown inside `execute()` are caught, logged at `error` level, and do not crash the runner or affect other registered jobs.
