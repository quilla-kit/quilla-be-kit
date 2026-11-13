---
'@quilla-be-kit/messaging': patch
---

README: a "How it runs" section explains the deployment model (no broker to deploy; the bus is tables in a shared Postgres database; each backend instance polls it through its own pool; the outbox lives in the service's own database; coordination only through claims, leases and locks). The architecture diagram now includes `event_deliveries`. Quick start step 2 shows how events reach the outbox with `@quilla-be-kit/ddd` and `@quilla-be-kit/persistence`: aggregates stage events, the aggregate repositories register them (`create`, `loadForUpdate*`), and the unit of work drains them into the outbox at commit. Its `serialize` now puts the event's own payload in the envelope, matching what handlers and descriptor schemas receive, and the event's id on the outbox row.
