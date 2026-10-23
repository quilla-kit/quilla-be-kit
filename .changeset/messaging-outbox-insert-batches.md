---
'@quilla-be-kit/messaging': patch
---

`PgLocalOutbox.insert` accepts any number of entries. It bound 15 parameters per entry in one statement, so a commit with more than 4,369 events exceeded Postgres' 65,535-parameter limit and rolled back the whole unit of work. Larger batches are now written in several statements on the caller's transaction; a batch of 4,369 entries or fewer emits the same SQL as before. `LocalOutboxWriter.insert` now documents that implementations accept any batch size and that `trx` must be an open transaction.
