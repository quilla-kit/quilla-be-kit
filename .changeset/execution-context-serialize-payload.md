---
'@quilla-be-kit/execution-context': patch
---

README: the "Emitting event metadata" example puts the event's own payload in the envelope (`event.payload`, not `event.toJSON()`), matching what `@quilla-be-kit/messaging` handlers and descriptor schemas receive.
