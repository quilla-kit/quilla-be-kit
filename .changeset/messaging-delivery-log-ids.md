---
'@quilla-be-kit/messaging': patch
---

Under isolation, the consumer's own log lines for a delivery attempt (`handler failed`, `permanent handler failure; skipping retries`, `handler context is unusable`, a throwing `onProcessed`/`onFailed` hook, and the claim-lease lines) put the delivery's id in `eventId`. They now log the original event's id as `eventId` and the delivery's id as `deliveryId`, so every attempt of one event correlates in the logs. Hooks and `onLeaseLost` are unchanged.
