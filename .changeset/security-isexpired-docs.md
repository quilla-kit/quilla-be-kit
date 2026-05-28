---
"@quilla-be-kit/security": patch
---

Document `Token.isExpired(now?: Date)` optional `now` parameter. The interface signature had it; the README intro listed `isExpired()` without it, leaving the testability injection point undiscovered.
