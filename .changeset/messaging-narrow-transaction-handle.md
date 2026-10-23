---
'@quilla-be-kit/messaging': minor
---

`TransactionHandle` asks only for what the outbox uses: `query(sql, params?) => Promise<unknown>`. Any transaction object with that method — a driver client, or another library's transaction type — can now be passed to `LocalOutboxWriter.insert` without a cast. Implementations written against the previous generic signature still satisfy it.

**Breaking:** code that called `query<Row>()` or read `.rows` through a value typed as `TransactionHandle` no longer compiles; type that value as your driver's own transaction type instead.

The README's `UnitOfWork` wiring example now type-checks: it passes an inline `sink` that calls `outbox.insert(entries, trx)`.
