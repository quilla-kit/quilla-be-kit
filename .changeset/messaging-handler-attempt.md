---
'@quilla-be-kit/messaging': minor
---

`EventConsumer` gets an `onHandlerAttempt` hook, called after every handler attempt with `source`, `handlerKey`, `member`, `attempt`, `startedAt`, `durationMs` and the attempt's own outcome (`done`, or `failed` with `permanent` and the error). It works with and without isolation, for events and deliveries. It isn't called when no handler runs (a blocked lane, a recorded outcome). The README's new "Per-handler timing" section shows how to derive publish-to-start, claim-to-start and retry waits from the entry.

Async hooks no longer cause unhandled rejections: when `onProcessed`, `onFailed`, `onLeaseLost`, `onHandlerAttempt` or the forwarder's `onFailed` returns a promise that rejects, the rejection is logged as `<hook> hook threw`, the same as a synchronous throw.
