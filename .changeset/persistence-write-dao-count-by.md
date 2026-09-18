---
"@quilla-be-kit/persistence": minor
---

`BaseWriteDao` gains `countBy(where?, trx?)`, a filtered `SELECT COUNT(*)` mirroring the existing `existsBy` shape (`FilterQuery<TRow>` in, scalar out, straight through to the adapter). Backs it with a new `WriteDbAdapter.count()` primitive and a Postgres implementation reusing the same `buildWhere` parameterization as `exists`/`find`.

This closes the gap for write-side precondition guards that only need a count — e.g. "don't deactivate the last active admin" — which previously had to `findMany(...).length`, fetching and hydrating every matching row to produce one integer.

```ts
async countBy(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<number>;
```

`where` is optional — omit it to count every row in the table, same convention already used by the read-side `select`/`findPaginated` path for an unfiltered query.
