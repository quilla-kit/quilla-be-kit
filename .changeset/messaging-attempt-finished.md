---
'@quilla-be-kit/messaging': minor
---

Renames `EventConsumer`'s `onHandlerAttempt` option, added in 0.17.0, to `onAttemptFinished`, so it reads like the other hooks (`onProcessed`, `onFailed`, `onLeaseLost`) and makes clear it fires after the attempt. Its arguments (`HandlerAttemptInfo`) and behaviour are unchanged. Rename the option where you pass it.
