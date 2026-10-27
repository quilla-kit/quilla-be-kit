# @quilla-be-kit/persistence

A layered persistence toolkit. Use the layers you need — each one works on
its own, and each higher layer is built only on the public surface of the one
below:

```
Database + adapters      PgDatabase, PgWriteDbAdapter, PgReadDbAdapter, …
        ▲
DAOs + UnitOfWork        KeyedWriteDao, BaseWriteDao, BaseReadDao, BaseRoutineDao, UnitOfWork
        ▲
Row repositories         KeyedBasicRepository, BaseBasicRepository            (optional)
        ▲
Aggregate repositories   BaseScoped/UnscopedAggregateRepository, mappers     (optional, DDD)
```

DDD is a layer on top, not a requirement: a service that only needs DAOs and
transactions never installs or imports `@quilla-be-kit/ddd`. The package's
tests enforce the direction — a lower layer that imports a higher one fails
the build.

Ships a **Postgres reference implementation** under
`@quilla-be-kit/persistence/postgres`, backed by the `pg` package.

## Choose your layers

| You need | Use | Install |
| --- | --- | --- |
| Parameterised SQL in transactions | `PgDatabase` + `UnitOfWork` (`ctx.trx.query(sql, params)`) | `persistence errors pg` |
| Table access: keyed or keyless, audit columns, optimistic locking, predicate writes | + write/read/routine DAOs | same |
| Row-level repositories over those DAOs | + `KeyedBasicRepository` / `BaseBasicRepository` | same |
| DDD aggregates: mappers, aggregate repositories, domain events at commit | + `@quilla-be-kit/persistence/aggregate` | + `@quilla-be-kit/ddd` |
| `inserted_by`/`updated_by` from the request context | an `ActorProvider` — an `ExecutionContextProvider` is one | + `@quilla-be-kit/execution-context` if you use it |

## Install

```sh
# DAOs, unit of work, row repositories:
pnpm add @quilla-be-kit/persistence @quilla-be-kit/errors pg

# Plus the DDD layer:
pnpm add @quilla-be-kit/ddd
```

`@quilla-be-kit/errors` is a required peer. `@quilla-be-kit/ddd` is an
optional peer, needed only by the `/aggregate` entry point. `pg` is an
optional peer, needed only by `/postgres`; `zod` only by `/query-schema`.

### Entry points

| Import from | Contains |
| --- | --- |
| `@quilla-be-kit/persistence` | `Database` contracts, adapter ports, DAOs, `UnitOfWork`, row repositories, query builder contracts, errors |
| `@quilla-be-kit/persistence/postgres` | `PgDatabase`, `PgTransaction`, `PgWriteDbAdapter`, `PgReadDbAdapter`, `PgRoutineDbAdapter`, `PgSqlQueryBuilder` |
| `@quilla-be-kit/persistence/aggregate` | aggregate repositories, `PersistenceMapper` / `BasePersistenceMapper`, and `UnitOfWork` / `UnitOfWorkContext` typed for DDD events |
| `@quilla-be-kit/persistence/query-schema` | `createQueryParametersSchema` (Zod) |

Sub-path entry points need `moduleResolution` `NodeNext` or `Bundler`.

## Architectural invariants

**Every layer**

- **CQRS isolation at the type level.** `ReadDbAdapter` exposes only
  `select`/`raw`; `WriteDbAdapter` exposes `insert`/`update`/`delete`/`find`/
  `findForUpdate`/`exists`/`count`. A single physical class can implement
  both interfaces for wiring convenience, but DAO-facing types enforce the
  boundary. **Read DAOs never accept a `trx` parameter** — reads don't
  participate in write transactions.
- **One bulk write is one atomic call, whatever its size.** `insert` and
  `updateMany` accept any number of rows. When a batch needs more than one
  statement, the statements run on the caller's `trx`, or in a transaction
  the adapter opens itself when there is none — either way all rows land or
  none do. See [Bulk writes](#bulk-writes).
- **Nested `transaction()` calls JOIN** — an inner call sees the outer
  `UnitOfWorkContext` (via AsyncLocalStorage) and reuses the trx.

**DAO layer**

- **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by`
  come from the DAO's `contextProvider` (`getContext().session?.userId`) on
  every write that stamps them. Callers cannot pass them; rows with audit
  fields in them get stripped. Writes without a session persist `null`
  audit. Which columns exist, and what they are called, is the DAO's
  `auditPolicy` (default `'kit'`); a policy that records no actor needs no
  provider — see
  [Tables that don't match the kit's shape](#tables-that-dont-match-the-kits-shape).
- **Optimistic locking is opt-in via `updated_at`.** Include `updated_at`
  in the row passed to `update()`, or as `row.updated_at` passed to
  `delete()`, and the DAO asserts `rowCount === 1` — a zero-row match
  throws `OptimisticLockError`, whether that's because `updated_at` no
  longer matched or because the row was already gone. `OptimisticLockError`
  therefore means "the row wasn't in the expected state," not strictly
  "someone else just modified it" — callers that need to tell "conflict"
  apart from "already deleted" must check existence themselves (e.g. a
  preceding `findOneById`). Omit `updated_at` to update/delete
  unconditionally. `updateMany`/`deleteMany` have no per-row lock — callers
  needing concurrency control on a bulk write should `findManyForUpdate`
  first; the row-level locks held inside the transaction already serialize
  concurrent writers.
- **Predicate writes never widen by accident.** `updateBy`/`deleteBy`/
  `findSingle*` reject an `undefined` value, an empty `where`, and filters
  that would match every row; a whole-table write needs the explicit
  `ALL_ROWS`. An `undefined` key value on a key-addressed method throws too.
  See [Predicate writes](#predicate-writes--updateby--deleteby--findsingle).
- **Pre-create uniqueness checks and precondition guards use the write
  side's unlocked reads** (`findOne` / `existsBy` / `countBy`), not the read
  side. `countBy` is a filtered `SELECT COUNT(*)` — use it instead of
  `findMany(...).length` when only the count is needed (e.g. "don't
  deactivate the last active admin"); omit `where` to count every row in the
  table. Locked reads (`findOneForUpdate`) are for read-before-update only.

**Unit of work**

- **Events are orthogonal, not built-in.** Give `UnitOfWork` an `events: {
  sink, serialize }` option to write registered events in the same
  transaction — through an `EventSink` such as an outbox. Omit it for apps
  that don't publish events. See [Transactions](#transactions--unitofwork).

**Repository and DDD layers**

- **Scope isolation is repo-layer explicit.** `BaseScopedAggregateRepository`
  takes `scopeId` on every load and throws `CrossScopeAccessError` on miss
  or mismatch. DAOs never inject `scope_id` implicitly.
- `BaseAggregateRepository.delete(aggregate, expectedUpdatedAt, ctx)`
  requires the expected version explicitly — pass `aggregate.updatedAt` to
  reproduce CAS protection off a `loadForUpdate*` read, or a caller-claimed
  version if you need to check against something other than what was just
  read.

## Vocabulary

- **DAO** layer — verb `find*`. Returns raw `TRow` from the database.
- **Routine DAO** layer — verb `call*`. Calls stored procedures and
  functions; see [Stored routines](#stored-routines).
- **Repository** layer — verb `load*`. Returns `TAggregate` mapped from
  rows. The verb split marks the layer.

Repositories and aggregates are optional layers over the DAOs.

## Quickstart — DAOs only

No repositories, no aggregates, no `@quilla-be-kit/ddd`:

```ts
import {
  ALL_ROWS,
  type AuditPolicy,
  BaseWriteDao,
  KeyedWriteDao,
  UnitOfWork,
} from '@quilla-be-kit/persistence';
import { PgDatabase, PgWriteDbAdapter } from '@quilla-be-kit/persistence/postgres';

type EventLogRow = { source: string; message: string; logged_at: Date };
type CustomerRow = { id: string; name: string; email: string; status: string; last_seen_at: Date };

// A keyless table with no audit columns: no actor provider needed.
class EventLogDao extends KeyedWriteDao<EventLogRow, never> {
  protected readonly tableName = 'event_log';
  protected readonly keyColumns = [] as const;
  protected override readonly auditPolicy: AuditPolicy = 'none';
}

// A kit-shaped table: string `id`, `created_at`/`updated_at`, `inserted_by`/`updated_by`.
class CustomerDao extends BaseWriteDao<CustomerRow> {
  protected readonly tableName = 'customers';
}

const db = new PgDatabase({ connectionString: process.env.DATABASE_URL });
const adapter = new PgWriteDbAdapter(db);
const uow = new UnitOfWork({ db });

const eventLog = new EventLogDao(adapter);
// Any object with `getContext()` — an ExecutionContextProvider works as is.
const customers = new CustomerDao(adapter, {
  getContext: () => ({ session: { userId: currentUserId() } }),
});

await uow.transaction(async ({ trx }) => {
  const archived = await customers.updateBy(
    { status: 'inactive', last_seen_at__lt: cutoff },
    { status: 'archived' },
    trx,
  );
  await eventLog.create(
    { source: 'archiver', message: `${archived} archived`, logged_at: new Date() },
    trx,
  );
  // null when nothing matches; TooManyRowsError when more than one row does.
  const owner = await customers.findSingle({ email__eq: ownerEmail }, trx);
});

await eventLog.deleteBy({ logged_at__lt: retentionCutoff });
await eventLog.deleteBy(ALL_ROWS); // the whole table, on purpose
```

## Quickstart — adding repositories and aggregates (DDD)

The DDD layer is built on the same DAOs and unit of work, imported from
`/aggregate`:

```ts
import { BaseReadDao, BaseWriteDao } from '@quilla-be-kit/persistence';
import {
  BasePersistenceMapper,
  BaseScopedAggregateRepository,
  UnitOfWork,
} from '@quilla-be-kit/persistence/aggregate';
import {
  PgDatabase,
  PgReadDbAdapter,
  PgSqlQueryBuilder,
  PgWriteDbAdapter,
} from '@quilla-be-kit/persistence/postgres';

// 1. Write DAO for your row shape:
class UserDao extends BaseWriteDao<UserRow> {
  protected readonly tableName = 'users';
}

// 2. Mapper — extend BasePersistenceMapper for automatic column conversion:
class UserMapper extends BasePersistenceMapper<User, UserProps, UserRow> {
  protected createDomain(props: UserProps, id: string) {
    return User.reconstitute(props, id);
  }
}

// 3. Scoped repository:
class UserRepository extends BaseScopedAggregateRepository<User, UserRow> {}

// 4. Wire at composition root:
const db = new PgDatabase({ host, database, user, password });
// Or, to share the pool with PgLocalOutbox / PgEventBus — see "Sharing a Pool" below.
const writeAdapter = new PgWriteDbAdapter(db);
const readAdapter  = new PgReadDbAdapter(db);
// `serialize` receives each domain or integration event (typed `AnyEvent`).
const uow = new UnitOfWork({ db, events: { sink: outboxSink, serialize: toOutboxEntry } });

const userDao  = new UserDao(writeAdapter, contextProvider);
const userRepo = new UserRepository(new UserMapper(), userDao);

// 5. Use:
await uow.transaction(async (ctx) => {
  const user = await userRepo.loadForUpdateByIdAndScopeOrFail(
    userId, scopeId, ctx,
  );
  user.changeName('Alice');
  await userRepo.update(user, ctx);
  // Domain events written through the sink, trx committed atomically.
});

// Pre-create uniqueness check — unlocked read on the write side:
await uow.transaction(async (ctx) => {
  if (await userDao.existsBy({ email: input.email }, ctx.trx)) {
    throw new DuplicateEmailError({ email: input.email });
  }
  await userRepo.create(newUser, ctx);
});

// Precondition guard — filtered COUNT instead of findMany(...).length:
await uow.transaction(async (ctx) => {
  const activeAdmins = await userDao.countBy({ role: 'ADMIN', active: true }, ctx.trx);
  if (activeAdmins <= 1) {
    throw new LastActiveAdminError();
  }
  await userRepo.update(deactivatedAdmin, ctx);
});

// Read-side projections — one DAO exposes many query methods, each
// building its own SQL via `this.qb<T>()`. See "Read-side queries" below
// for the full flow (builder, column resolver, HTTP query schema).
class UserReadDao extends BaseReadDao {
  listActive(scopeId: string) {
    const q = this.qb<UserListRow>()
      .select(['id', 'name', 'createdAt'])
      .from('users')
      .filters({ scopeId, isActive: true })
      .orderBy([{ createdAt: 'desc' }])
      .build();
    return this.findMany<UserListRow>(q);
  }
}
const userReadDao = new UserReadDao({
  adapter: readAdapter,
  builderFactory: (r) => new PgSqlQueryBuilder(r),
});
const rows = await userReadDao.listActive(scopeId); // no ctx, no trx

// Pool lifecycle: register with @quilla-be-kit/runtime:
shutdown.addPhase({
  name: 'database',
  participants: [{ name: 'PgDatabase', dispose: () => db.disconnect() }],
});
```

## Database and adapters

### Sharing a Pool

`PgDatabase` accepts either a `PoolConfig` (the adapter creates and owns
the pool) or `{ pool }` (the caller owns it — use this when the same
physical Postgres connection pool needs to back other adapters like
`PgLocalOutbox` / `PgEventBus` from `@quilla-be-kit/messaging`):

```ts
import { Pool } from 'pg';
import { PgDatabase } from '@quilla-be-kit/persistence/postgres';
import { PgLocalOutbox, PgEventBus } from '@quilla-be-kit/messaging/postgres';

// Adapter-owned pool — disconnect() ends it:
const db = new PgDatabase({ connectionString: process.env.DATABASE_URL });

// Caller-owned pool — shared with the messaging adapters:
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PgDatabase({ pool });
const outbox = new PgLocalOutbox({ pool });
const bus = new PgEventBus({ pool });

// When the pool is caller-owned, db.disconnect() is a no-op.
// Register pool.end() on your ShutdownManager yourself:
shutdown.addPhase({
  name: 'database',
  participants: [{ name: 'pg.Pool', dispose: () => pool.end() }],
});
```

## DAO layer

### Handling optimistic lock conflicts

When an update includes `updated_at` in the input row, or a delete includes
`updated_at` alongside `id`, the DAO asserts `rowCount === 1` and throws
`OptimisticLockError` (extends `ConflictError` from `@quilla-be-kit/errors`)
on a zero-row match. Note this fires both when `updated_at` no longer
matches (a real concurrent modification) **and** when the row no longer
exists at all — the WHERE clause can't distinguish the two. Catch it at the
command handler boundary and retry or surface a 409 to the client; if your
caller needs to tell "conflict" apart from "already gone," check existence
first (e.g. `findOneById`) rather than relying on the error alone:

```ts
import { OptimisticLockError } from '@quilla-be-kit/persistence';

try {
  await uow.transaction(async (ctx) => {
    const user = await userRepo.loadForUpdateByIdOrFail(userId, ctx);
    user.changeName(newName);
    await userRepo.update(user, ctx);
  });
} catch (err) {
  if (err instanceof OptimisticLockError) {
    // someone else updated this row — retry, or surface 409 CONFLICT
  }
  throw err;
}
```

`BaseWriteDao.delete()` takes the same shape as `update()`'s row —
`{ id, updated_at? }` — instead of a bare id, so it can opt into the same
lock:

```ts
// Unconditional delete:
await userDao.delete({ id: userId }, ctx.trx);

// CAS-protected delete — throws OptimisticLockError if the row changed
// (or was already deleted) since it was read:
await userDao.delete({ id: userId, updated_at: knownUpdatedAt }, ctx.trx);
```

`BaseAggregateRepository.delete(aggregate, expectedUpdatedAt, ctx)` requires
the expected version as an explicit argument rather than deriving it from
the aggregate's in-memory state:

```ts
// CAS-protected off the loadForUpdate* read (the common case). `updatedAt`
// is typed `Date | undefined` on Entity (an unpersisted aggregate has
// none), but an aggregate that just came back from loadForUpdate* always
// has one — non-null assert or throw if you want that checked explicitly:
await userRepo.delete(user, user.updatedAt!, ctx);

// CAS-protected against a caller-claimed version instead — e.g. an
// If-Match / version field the client submitted before this transaction
// started, which may differ from what loadForUpdate* just read:
await userRepo.delete(user, clientClaimedUpdatedAt, ctx);
```

Being explicit means callers never need to mutate the aggregate's
`updatedAt` in memory to influence the lock — the value flows in directly.

### Tables that don't match the kit's shape

The write side is configured, not forked. Everything below is opt-in.

#### Which base do I use?

| Your table / need | DAO | Repository |
| --- | --- | --- |
| String `id` key, kit audit columns | `BaseWriteDao` | `BaseBasicRepository` (rows) or the aggregate repositories from `/aggregate` (aggregates) |
| Any other key: renamed, composite, or none | `KeyedWriteDao` + `keyColumns` | `KeyedBasicRepository` |
| Rows addressed by a condition rather than a key | either DAO: `updateBy` / `deleteBy` / `findSingle` | `updateBy` / `deleteBy` on either row repository |
| Different or missing audit columns | either DAO + `auditPolicy` | either |
| Mixed-case / reserved-word names, `schema.table` | either DAO, `PgWriteDbAdapter` with `quoteIdentifiers: true` | either |

The aggregate repositories stay `id`-keyed on purpose: an aggregate's identity
is `Entity.id`, which is a different concept from a row key.

#### Key columns — `KeyedWriteDao`

Extend it with the columns that identify a row (single or composite).
`BaseWriteDao` is exactly the `['id']` case.

```ts
import { KeyedWriteDao } from '@quilla-be-kit/persistence';

class OrderLineDao extends KeyedWriteDao<OrderLineRow, 'order_id' | 'line_no'> {
  protected readonly tableName = 'order_line';
  protected readonly keyColumns = ['order_id', 'line_no'] as const;
}

await dao.findOneByKey({ order_id: 'o1', line_no: 2 });
await dao.delete({ order_id: 'o1', line_no: 2 });
```

`update`/`updateMany`/`delete`/`deleteMany`/`findOneByKey` address rows by
`keyColumns` and never put them in a `SET` clause; `updateMany` joins on every
key column. With `keyColumns = []` these key-addressed methods throw — the
table is insert-only for them — while the
[predicate methods](#predicate-writes--updateby--deleteby--findsingle) work
as usual. A key value that is `undefined` throws as well, rather than binding
`NULL` and silently matching nothing.

#### Key sets — batches of keys

`deleteMany(keys, trx?)` takes a list of key objects;
`findManyForUpdateByKeys({ keys, limit?, orderBy?, onLocked? }, trx)` takes the same list
plus optional bounds (`limit` must be a non-negative integer), so a batch job
can lock a key pool one chunk at a time:

```ts
const chunk = await dao.findManyForUpdateByKeys(
  { keys: pending, orderBy: [{ column: 'line_no', direction: 'asc' }], limit: 100 },
  ctx.trx,
);
```

- **Single key column:** one statement using `= ANY(...)`, as before.
- **Composite key:** one statement when the adapter provides the optional
  `deleteByKeys` / `findByKeysForUpdate` methods (`PgWriteDbAdapter` does, as
  `DELETE ... WHERE EXISTS (... unnest(...))` with one array parameter per key
  column). Otherwise the DAO runs one statement per key. Pass a `trx` when
  you rely on all-or-nothing behaviour — the per-key fallback is only atomic
  inside a transaction.
- On the single-statement path, rows come back (and are locked) in `orderBy`
  order when given, otherwise in unspecified order, and duplicate keys
  collapse. Empty input is a no-op.
- The per-key fallback locks in the order you pass, returns a row per
  occurrence (duplicates count toward `limit`) and stops once `limit` rows are
  locked. It can't order across keys, so `orderBy` on a composite key throws
  unless the adapter implements `findByKeysForUpdate`.
- `onLocked` (see [Filtering on write DAOs](#filtering-on-write-daos)) applies
  on every path, per key on the fallback. With `'skip'` a busy key just yields
  no row; the DAO doesn't report which keys were skipped.
- On the composite path `PgWriteDbAdapter` aliases the table as `t`: write
  `orderBy` columns unqualified (or `t.`-qualified), not `table.column`.
- Key columns of array types aren't supported for composite key sets (the
  adapter throws).

`findManyForUpdateByKeys` exists because `FilterQuery` combines conditions
with AND only: `findManyForUpdate({ where: { a: [..], b: [..] } }, trx)`
matches the cross product of the values, not the pairs, and would lock rows
you didn't ask for.

#### Predicate writes — `updateBy` / `deleteBy` / `findSingle`

Address rows by a `where` filter instead of the key — the table may have no
key at all:

```ts
// UPDATE … SET status = 'archived', updated_by = …, updated_at = now() WHERE …
const archived = await dao.updateBy(
  { status: 'inactive', last_seen_at__lt: cutoff },
  { status: 'archived' },
  ctx.trx,
);

const removed = await dao.deleteBy({ batch_id__eq: batchId }, ctx.trx);

// At most one row expected: null for none, TooManyRowsError for more.
const row = await dao.findSingle({ code__eq: code }, ctx.trx);
const locked = await dao.findSingleForUpdate({ code__eq: code }, ctx.trx, { onLocked: 'nowait' });
```

| Method | Returns |
| --- | --- |
| `updateBy(where, set, trx?)` | affected rows |
| `deleteBy(where, trx?)` | affected rows |
| `findSingle(where, trx?)` | the row, or `null` |
| `findSingleForUpdate(where, trx, { onLocked? }?)` | the row, or `null`, locked |

The `where` is strict, so a mistake can't widen a write:

- An `undefined` value throws — it is never skipped.
- An empty `where` throws. To address every row, pass `ALL_ROWS`:
  `dao.deleteBy(ALL_ROWS, trx)`.
- Filters that would match every row throw: an empty `__notIn` /
  `__notInStrict` list, or an empty `__contains` string.
- `where` must be a plain object.
- `null` is allowed; the operator decides what it means (`status: null` is
  `IS NULL`, `status__eq: null` matches no row — see
  [The filter suffix DSL](#the-filter-suffix-dsl)).

`updateBy`'s `set`:

- Stamps audit columns exactly as `update` does under the DAO's
  `auditPolicy` (`updated_by`, `updated_at`).
- May set key columns — unless they are `generatedColumns`.
- Throws on an empty `set`, an `undefined` value, or a declared audit or
  generated column.
- Never takes an optimistic lock; put the expected version in `where` if you
  need one.

`findSingle` reads at most two rows and throws `TooManyRowsError` (code
`TOO_MANY_ROWS`, `context.entity` = table) when it gets two.
`findSingleForUpdate` has locked both rows by then — let the unit of work
roll back. Its `onLocked` takes `'wait'` (default) or `'nowait'`; `'skip'`
isn't offered, because skipping a locked second row would hide it from the
check.

All four run on the caller's `trx` when given, and work with
`keyColumns = []`.

#### Audit policy — `auditPolicy`

Declares which audit/timestamp columns the table has:

```ts
class CodeDao extends KeyedWriteDao<CodeRow, 'code'> {
  protected readonly tableName = 'codes';
  protected readonly keyColumns = ['code'] as const;
  // 'kit' (default) | 'none' | a map; omit an entry or pass false when absent
  protected override readonly auditPolicy: AuditPolicy = {
    updatedAt: 'modified_at',
    insertedBy: 'created_by',
  };
}
```

`created_at`/`updated_at`-style columns are stamped by the database clock;
`inserted_by`/`updated_by`-style columns are stamped from the DAO's
`contextProvider`. Only declared columns are written, and undeclared columns are left
alone (a real `created_at` column under `'none'` is ordinary data). The
optimistic lock applies only when an `updatedAt` column is declared, and the
expected value is read from the row property named by that column. A
composite key is joined into `OptimisticLockError`'s `id` (comma-separated)
and also passed as `context.key`. The `prepareInsertRow` / `prepareUpdateRow` /
`stripKeys` hooks are `protected` for finer control.

The provider is read **only** when the policy declares an `insertedBy` or
`updatedBy` column. A DAO under `'none'` — or one declaring timestamps only —
never calls it, so it runs in jobs, scripts, migrations and tests with no
`runWithContext` scope, and can be constructed without one:
`new EventLogDao(adapter)`. `update`/`updateMany` read it only for
`updatedBy`, so the `CodeDao` above reads it on insert and not on update.
When the policy does record an actor and no provider was given, the first
write that needs it throws.

The provider is any `ActorProvider` — an object whose
`getContext().session?.userId` names the actor. An `ExecutionContextProvider`
from `@quilla-be-kit/execution-context` is one; so is
`{ getContext: () => ({ session: { userId } }) }`. The DAO's protected
`contextProvider` field is typed `ActorProvider | undefined`; keep your own
typed reference if a subclass needs more of the execution context.

#### Database-produced columns — `generatedColumns`

Declares columns the database fills in: identity/serial keys,
`GENERATED ALWAYS AS` columns, and anything a trigger maintains.

```ts
class TicketDao extends KeyedWriteDao<TicketRow, 'ticket_no'> {
  protected readonly tableName = 'tickets';
  protected readonly keyColumns = ['ticket_no'] as const;
  protected override readonly generatedColumns = ['ticket_no', 'search_vector'];
}
```

Declared columns are excluded from the INSERT column list **and** from the
UPDATE `SET` clause, while still addressing rows as key columns — so an
identity primary key works end to end. To read the stored row back, including
the values the database produced:

```ts
const ticket = await dao.createReturning({ ticket_no: 0, title: 'Broken link' });
ticket.ticket_no; // 4711, assigned by the sequence

const tickets = await dao.createManyReturning(rows);
```

`KeyedBasicRepository` (and so `BaseBasicRepository`) exposes the same
`createReturning` / `createManyReturning`.

**What this does NOT do:**

- It does not change `TRow`'s type. You still pass a value for a generated
  column unless your row type declares it optional — it is stripped before the
  INSERT either way. `BaseWriteDao<TRow extends { id: string }>` requires a
  `string` `id`, so tables with a generated key are better served by extending
  `KeyedWriteDao` directly with the key declared optional.
- It does not verify the column exists, or that the database actually
  generates it.
- `create` and `createMany` still return `void` — use the `*Returning`
  variants when you need the row back. `createManyReturning([])` returns `[]`
  without touching the database.
- Aggregate repositories have no `createReturning`: aggregate identity is
  client-generated (`Entity.id`), so a database-assigned key contradicts the
  model.
- An adapter that ignores `returning` causes a thrown `Error`, not an empty
  result.
- If every settable column ends up excluded, `update` reports `0` rather than
  running a statement — `PgWriteDbAdapter` no-ops an empty `SET`, the same
  answer `updateMany` already gave.

#### Affected-row counts

`update`, `updateMany`, `delete`, `deleteMany`, `updateBy` and `deleteBy`
return the number of rows the adapter reported affected:

```ts
const removed = await dao.deleteMany(['a', 'b', 'c']);
if (removed === 0) { /* nothing matched */ }
```

**What this does NOT do:**

- Counts mostly stop at the DAO. `KeyedBasicRepository`,
  `BaseBasicRepository` and `BaseAggregateRepository` return `void` from their
  key-addressed writes — how many rows a statement touched is a storage fact,
  not a domain verb. The row repositories' `updateBy`/`deleteBy` are the
  exception: for a predicate write the count is the only feedback.
- `create`/`createMany` return `void`; their count is deterministic.
- On a locked `update`/`delete` the count is never `0` — a zero-row match
  throws `OptimisticLockError` instead, so `if (await dao.update(row) === 0)`
  is unreachable there.
- An adapter that omits `rowCount` reports `0`.
- `PgWriteDbAdapter` reports `0` from `update`/`updateMany` when there is
  nothing to set: no statement runs.
- `deleteMany`'s per-key fallback sums what the database reported, which
  counts rows, not distinct keys.

#### Bulk writes

`createMany`, `createManyReturning` and `updateMany` take batches of any size.
Postgres binds at most 65,535 parameters per statement, so
`PgWriteDbAdapter` splits a batch that would exceed that into statements of
`floor(65535 / columns per row)` rows and runs them in order:

- With a `trx`, every statement runs on it — a failure leaves the
  transaction to your rollback, as with any other write.
- Without one, the adapter opens its own transaction for the batch, commits
  it, and rolls it back if any statement fails.
- A batch that fits in one statement is sent exactly as before, and no
  transaction is opened for it.
- The returned count is the sum across statements; returned rows come back in
  input order.

**What this does NOT do:**

- Deletes and `IN` filters need no splitting: a key list is bound as one
  array parameter, whatever its length.
- Two rows with the same key in one `updateMany` batch: which one wins is
  unspecified.

#### Identifier quoting

`PgWriteDbAdapter` emits identifiers unquoted by default. Pass
`quoteIdentifiers: true` to double-quote every table and column it emits and
to accept `schema.table` names (column types are then resolved for that
schema):

```ts
const adapter = new PgWriteDbAdapter(db, { quoteIdentifiers: true });
// or, sharing a type cache: { columnTypeCache, quoteIdentifiers: true }
```

Pass raw names, never pre-quoted ones. Caller-supplied `SelectOptions.columns`
and `orderBy` are passed through as given, since they may be expressions.
`FilterQuery` keys use `__` as the operator delimiter, so a column whose own
name contains `__` can't be addressed through a filter. `returning` is either
`'all'` (the whole stored row) or a list of column names — "all columns" is
structural rather than a magic column name, so every dialect can spell it its
own way.

The read side takes the same option — see
[Quoting on the read side](#quoting-on-the-read-side).

#### Repositories for keyed rows — `KeyedBasicRepository`

The repository twin of `KeyedWriteDao`: `create`/`createMany`/`update`/
`updateMany`/`delete`/`deleteMany` with key objects, the optimistic-lock
value under whatever column the DAO's `auditPolicy` declares, and
`updateBy`/`deleteBy` predicate writes returning the affected count. Row
repositories expose no reads; use the DAO.

```ts
class OrderLineRepository extends KeyedBasicRepository<OrderLineRow, 'order_id' | 'line_no'> {}

const repo = new OrderLineRepository(new OrderLineDao(adapter, contextProvider));

await uow.transaction(async (ctx) => {
  const lines = await dao.findManyForUpdateByKeys(
    { keys: [{ order_id: 'o1', line_no: 1 }, { order_id: 'o1', line_no: 2 }] },
    ctx.trx,
  );
  await repo.deleteMany(lines, ctx.trx);
});
```

`BaseBasicRepository` is the `id`-keyed case and keeps its existing signatures.

#### Write-DAO contracts — `WriteDao` / `IdWriteDao`

The repository bases depend on two interfaces, not on the DAO classes:

| Interface | Implemented by | Used by |
| --- | --- | --- |
| `WriteDao<TRow, TKey>` | `KeyedWriteDao` | `KeyedBasicRepository` |
| `IdWriteDao<TRow>` (`WriteDao<TRow, 'id'>` + `findOneById`, `deleteMany` with bare ids) | `BaseWriteDao` | `BaseBasicRepository`, the aggregate repositories (`/aggregate`) |

`WriteDao` includes the predicate methods (`findSingle`, `findSingleForUpdate`,
`updateBy`, `deleteBy`), so a hand-written implementation provides them too.

Each repository base takes the DAO type as an optional last type parameter.
Left out, it is the kit's class, exactly as before. Pass your own contract to
give `this.writeDao` your DAO's extra queries, or to back a repository with
something other than the kit's DAO classes:

```ts
interface UserWriteDao extends IdWriteDao<UserRow> {
  findByEmail(email: string, trx?: DatabaseTransaction): Promise<UserRow | null>;
}

class PgUserWriteDao extends BaseWriteDao<UserRow> implements UserWriteDao {
  protected readonly tableName = 'users';
  async findByEmail(email: string, trx?: DatabaseTransaction) {
    return this.findOne({ email }, trx);
  }
}

class UserRepository extends BaseUnscopedAggregateRepository<User, UserRow, UserWriteDao> {
  async loadByEmail(email: string): Promise<User | null> {
    const row = await this.writeDao.findByEmail(email);
    return row ? this.mapper.toDomain(row) : null;
  }
}
```

Without the type parameter the constructor still expects the class, so a
`UserWriteDao` that isn't a `BaseWriteDao` is rejected. Any object with the
contract's methods satisfies it — a test double can be a plain object.

#### For adapter authors

`WriteDbAdapter` is the extension point for other databases or your own
adapter. Everything new is optional, so an adapter implementing only the
original eight methods keeps working:

- `update` and `delete` must throw on an empty `where` unless `allRows: true`
  is set (then `where` is `{}`) — this is what makes `ALL_ROWS` the only way
  to reach every row. An adapter that ignores `allRows` keeps refusing the
  empty `where`, so it fails closed.

- `audit?: { createdAt?, updatedAt? }` on `InsertOptions`, `UpdateOptions` and
  `UpdateManyOptions` — the timestamp columns to stamp with the database clock.
  Omitted means `created_at`/`updated_at`; `{}` means stamp nothing.
- `keyColumns?` on `UpdateManyOptions` — join columns (default `['id']`).
- `deleteByKeys?(opts, trx?)` and `findByKeysForUpdate?(opts, trx)` — take a
  `KeySet` (`{ keyColumns, keys }`) and act on all matching rows in one
  statement. Implement them if your database can; otherwise leave them out and
  the DAO falls back to one call per key. `findByKeysForUpdate` receives
  `KeySetSelectOptions`, which adds optional `limit` and `orderBy`; an
  implementation must honor both, or callers lock more rows than they asked
  for.
- `onLocked?` on `findForUpdate`'s `LockedSelectOptions` and on
  `KeySetSelectOptions` — the lock wait policy (`'wait'` | `'skip'` |
  `'nowait'`, default `'wait'`). An implementation must honor it: one that
  ignores it always waits, so `'skip'` gives callers no parallelism and
  `'nowait'` blocks instead of throwing.

`insert` and `updateMany` must accept a batch of any size and apply it
all-or-nothing: on the caller's `trx` when given, otherwise in a transaction
of the adapter's own whenever the batch needs more than one statement. Split
by your database's parameter limit if it has one.

The Postgres building blocks are exported from `/postgres` for reuse:
`buildWhere` (takes an optional column-quoting function), `buildKeySet`,
`keyPredicate`, `mapPostgresType`, `NO_QUOTING`/`QUOTED` and the
`IdentifierQuoter` and `ColumnTypeMap` types; `CountOptions`,
`UpdateManyOptions`, `AuditTimestamps`, `LockedSelectOptions`, `OnLocked` and
the key-set option types are exported from the main entry.

### Filtering on write DAOs

`WriteDbAdapter`'s `where` option (used by the write DAOs' `findOne` /
`findMany` / `findOneForUpdate` / `findManyForUpdate` / `existsBy` /
`countBy` and the predicate methods) accepts the same operator-suffix DSL as the read-side
`SqlQueryBuilder` — see [The filter suffix DSL](#the-filter-suffix-dsl) below
for the full operator table. Two differences from the read side:

- Keys are **raw DB column names** (`expires_at__lt`), not the camelCase,
  `ColumnResolver`-resolved names `SqlQueryBuilder` uses — write DAOs have no
  resolver.
- `__gt/__gte/__lt/__lte` are typed for `number`, `bigint`, `string` and
  `Date` fields. The comparison follows the column's SQL type: a
  `bigint`/`numeric` column held as `string` in your row type compares
  numerically, a text column compares as text.

This is what makes a locked, range-filtered sweep read possible without
hand-written SQL. `findManyForUpdate({ where, limit?, orderBy?, onLocked? }, trx)`
bounds it to a fixed-size, oldest-first chunk per tick, and `onLocked: 'skip'`
lets concurrent sweepers each claim a disjoint chunk:

```ts
await uow.transaction(async (ctx) => {
  const overdue = await replacementDao.findManyForUpdate(
    {
      where: { status: 'PENDING', expires_at__lt: new Date() },
      orderBy: [{ column: 'expires_at', direction: 'asc' }],
      limit: 100,
      onLocked: 'skip',
    },
    ctx.trx,
  );
  for (const row of overdue) {
    // transition each row in the same locked transaction
  }
});
```

`onLocked` decides what happens on a row another transaction holds:

- `'wait'` (default, `FOR UPDATE`) — block until it's released. Concurrent
  sweepers — other replicas, or overlapping ticks, since `InProcessJobRunner`
  starts a tick even while the previous one is still running — then block on
  each other and get short or empty batches.
- `'skip'` (`FOR UPDATE SKIP LOCKED`) — leave it out. Each sweeper gets the
  next unclaimed rows, so `orderBy` holds within a chunk, not across sweepers;
  a short batch doesn't mean the work is done; and a row held indefinitely
  elsewhere is skipped indefinitely.
- `'nowait'` (`FOR UPDATE NOWAIT`) — throw the driver's lock error (Postgres
  `55P03`). The transaction is aborted, so catch it outside the unit of work.

`findOneForUpdate` takes no `onLocked`; use
`findManyForUpdate({ where, limit: 1, onLocked })` instead.

**Behavior note:** a literal `null` for a bare key (`{ status: null }`) emits
`status IS NULL`, not `status = $1` with a `null` parameter — the latter
never matches in Postgres. When you want the plain SQL `=`, use
`status__eq` — `status__eq: null` matches no row, exactly like `WHERE status
= NULL`.

**Sharp edge — `__notIn` on `delete`/`update`:** `field__notIn` compiles to
`(field <> ALL($n) OR field IS NULL)`, matching the read side's null-safe
`NOT IN` semantics. On a destructive write, this also matches rows where
`field IS NULL`: `delete({ status__notIn: ['DONE'] })` deletes every row with
`status IS NULL` too, not just rows with some other non-`DONE` status. Confirm
that's actually intended before using `__notIn` in a `delete` or `update`, or
use `__notInStrict` (`field <> ALL($n)`, SQL's own `NOT IN`), which leaves
`NULL` rows alone.

**Migration note — casting to `FilterQuery<T>` inside a generic method:**
`FilterQuery<T>` is now an intersection of several mapped types (the base
shape plus one per operator group). TypeScript can verify `Partial<Row>`
against `FilterQuery<Row>` for a *concrete* `Row`, but it can't verify
`Partial<T>` against `FilterQuery<T>` when `T` is still an unresolved generic
parameter — even though every added property is optional. If you have a
generic base repository/DAO method that builds a `Partial<TRow>` and passes
it somewhere typed `FilterQuery<TRow>`, that assignment will now fail to
compile. Cast directly to `FilterQuery<TRow>` instead of routing through
`Partial<TRow>` first — e.g. `{ id } as FilterQuery<TRow>`, not
`{ id } as Partial<TRow>` — which sidesteps the generic-assignability gap
entirely (this is the pattern `BaseWriteDao` uses internally).

## Transactions — `UnitOfWork`

`UnitOfWork.transaction(fn)` opens a transaction, runs `fn(ctx)`, and
commits — or rolls back if `fn` throws. Pass `ctx.trx` to every DAO call that
should be part of it. Nested `transaction()` calls join the outer one.

It needs nothing beyond a `Database`:

```ts
const uow = new UnitOfWork({ db });

await uow.transaction(async ({ trx }) => {
  await accounts.updateBy({ id__eq: from }, { balance: fromBalance }, trx);
  await accounts.updateBy({ id__eq: to }, { balance: toBalance }, trx);
  // Raw SQL in the same transaction — e.g. a join or aggregate no DAO covers:
  const { rows } = await trx.query('SELECT sum(balance) AS total FROM accounts', []);
});
```

**Events (optional).** With `events: { sink, serialize }`, the unit of work
collects events during `fn` and hands them to `sink.sink(entries, trx)` before
committing:

- `ctx.registerEventSource(source)` registers anything with
  `drainDomainEvents()` (a `DomainEventSource`). Registering the same object
  twice drains it once; distinct objects are all drained.
- `ctx.registerIntegrationEvent(event)` adds a standalone event.
- `serialize(event)` turns each event into the sink's entry type.

Imported from the main entry, `UnitOfWork<TEntry, TEvent>` leaves the event
type to you (`unknown` by default). The `/aggregate` entry point exports a
subclass typed for DDD events (`AnyEvent`) whose `UnitOfWorkContext` adds
`ctx.registerAggregate(aggregate)` — the aggregate repositories call it for
you. Use that one with aggregates; it is still a `UnitOfWork` from the main
entry.

## Stored routines

Subclass `BaseRoutineDao` and add one typed method per stored procedure or
function; one subclass can group any number of routines.

```ts
import { BaseRoutineDao, type DatabaseTransaction } from '@quilla-be-kit/persistence';
import { PgRoutineDbAdapter } from '@quilla-be-kit/persistence/postgres';

class BillingRoutinesDao extends BaseRoutineDao {
  protected override readonly schema = 'billing';

  closeOrder(orderId: string, trx?: DatabaseTransaction) {
    return this.callProcedure<{ p_total: number; p_closed_at: Date }>(
      {
        routine: 'close_order',
        args: [
          { name: 'p_order_id', value: orderId, type: 'uuid' },
          { name: 'p_total', mode: 'inout', value: 0 },
          { name: 'p_closed_at', mode: 'out' },
        ],
      },
      trx,
    );
  }

  orderTotal(orderId: string) {
    return this.callFunction({
      routine: 'order_total',
      returns: 'value',
      args: [{ value: orderId, type: 'uuid' }],
    });
  }

  openOrders(customerId: string) {
    return this.callFunction<Record<string, never>, { id: string; total: number }>({
      routine: 'open_orders',
      args: [{ value: customerId }],
    });
  }
}

const routines = new BillingRoutinesDao(new PgRoutineDbAdapter(db));
const { outputs } = await routines.closeOrder(orderId, ctx.trx);
const closedAt: Date = outputs.p_closed_at;
```

- `schema` applies to every call that doesn't set its own `schema`; omit both
  to use the database's search path. `routine` is always the bare name.
- `callProcedure` and `callFunction` are protected, so the subclass's methods
  are the only routines callers can reach.
- Pass `trx` to run inside a unit of work; the call commits or rolls back with
  it. Without `trx` the call runs on its own.
- Repositories use a routine DAO the same way they use a write DAO: take it as
  a constructor argument and pass `ctx.trx` down.

### Arguments

Each argument is `{ name?, mode?, value?, type? }`, in the order the routine
declares them:

- `mode` is `'in'` (default), `'out'` or `'inout'`. `out` and `inout`
  arguments must be named; their values come back in `outputs` under that
  name.
- `name` uses named notation (`p_order_id => $1`). Positional arguments must
  come before named ones.
- `value` is always bound as a parameter; it is ignored for `out` arguments.
- `type` is the database's type name (`uuid`, `numeric(10,2)`, `text[]`). Omit
  it to let the database infer the type from the value; set it when the
  routine is overloaded or inference picks the wrong type.

### Results

| Call | Result |
| --- | --- |
| `callProcedure` | `{ outputs, rows }`: `outputs` holds the declared `out`/`inout` values |
| `callFunction` (default `returns: 'rows'`) | `{ outputs, rows }`: `rows` is the result set; declared `out`/`inout` values are read from its first row |
| `callFunction` with `returns: 'value'` | `{ outputs, rows, returnValue }`: the function's single return value |

Adapters for other databases enforce the same argument rules by calling the
exported `routineOutputNames(call)`, which validates the arguments and returns
the `out`/`inout` names.

### Postgres

`PgRoutineDbAdapter` renders:

| Call | SQL |
| --- | --- |
| `callProcedure` | `CALL s.r(...)`; `out` arguments are passed as `NULL` placeholders |
| `callFunction` | `SELECT * FROM s.r(...)`; `out` arguments are left out of the call and come back as columns |
| `callFunction` with `returns: 'value'` | `SELECT s.r(...) AS "returnValue"`; `out`/`inout` arguments are rejected |

- Output values are read by the name Postgres reports, which for an unquoted
  parameter name is its lower-case form.

- `out` parameters on procedures need Postgres 14 or later; `inout` works
  from Postgres 11.
- Pass `{ quoteIdentifiers: true }` to double-quote schema, routine and
  argument names (mixed-case or reserved names). Without it, each must be a
  plain identifier. Type names are validated either way.
- Errors are the driver's own: a missing routine is SQLSTATE `42883`, an
  ambiguous overload `42725`. Catch them by `code` as with any other query.

## Mappers — row ↔ aggregate conversion

Part of the DDD layer: import `BasePersistenceMapper` and `PersistenceMapper`
from `@quilla-be-kit/persistence/aggregate`.

`BasePersistenceMapper` handles the bidirectional row↔aggregate conversion
with **no explicit column list**. It uses prototype reflection on the
aggregate to discover persisted properties, then converts names between
`camelCase` (domain) and `snake_case` (DB) automatically.

### The contract your aggregate must follow

For a domain property to be persisted, the aggregate must expose both a
getter and a setter for it on the class prototype:

```ts
class Tenant extends AggregateRoot<TenantProps> {
  // Persisted — private setter + public getter pair:
  private set name(v: string) { this.props.name = v; }
  get name(): string { return this.props.name; }

  private set country(v: string) { this.props.country = v; }
  get country(): string { return this.props.country; }

  // Computed — getter only; mapper ignores it:
  get displayName(): string { return `${this.name} (${this.country})`; }
}
```

Why setters? The mapper distinguishes **persisted** properties from
**computed** ones by checking whether a setter exists. `private` is the
right visibility — only the aggregate itself should mutate state; external
callers use intention-revealing methods (`tenant.changeName('NewName')`)
that internally assign `this.name = 'NewName'`, which routes through the
private setter.

Setters are also where **structural invariants** live (non-empty strings,
non-null required fields) — guards that must hold after rehydration from
the DB, not just after a command. See
[mutation patterns in `@quilla-be-kit/ddd`](../ddd/README.md#mutation-patterns)
for the full command-side idiom (`updateFromInput`, `changeX`, domain
methods) and how structural vs. business invariants split between setters
and mutation methods.

### Mapper — minimum boilerplate case (pure snake_case)

When every domain property name maps cleanly to its snake_case column
(e.g. `adminEmail` ↔ `admin_email`), the mapper is just one method:

```ts
import { BasePersistenceMapper } from '@quilla-be-kit/persistence/aggregate';

class TenantMapper extends BasePersistenceMapper<Tenant, TenantProps, TenantRow> {
  protected createDomain(props: TenantProps, id: string): Tenant {
    return Tenant.reconstitute(props, id);
  }
}
```

That's it. The base iterates every `get`+`set` accessor pair on `Tenant`'s
prototype chain (including inherited `createdAt` / `updatedAt` /
`insertedBy` / `updatedBy` from `Entity`), converts each name to
snake_case, and reads values via the getter.

`createDomain` calls `Tenant.reconstitute(props, id)` — the rehydration
factory that skips validation and emits no domain events (contrasted
with `Tenant.create(...)`, the new-aggregate factory). See
[construction patterns in `@quilla-be-kit/ddd`](../ddd/README.md#construction-patterns)
for why these are two separate factories and what each is responsible for.

### Mapper — with overrides + value-object serialization (User)

When some columns don't follow the convention, and some properties wrap
value objects that need scalar serialization:

```ts
class UserMapper extends BasePersistenceMapper<User, UserProps, UserRow> {
  // Only declare the odd-ones-out:
  protected readonly columnOverrides = {
    password: 'password_hash',
    resetPasswordTokenExpiresAt: 'reset_password_token_expiration',
  } as const;

  protected createDomain(props: UserProps, id: string): User {
    return User.reconstitute({
      ...props,
      // Wrap scalar → value object on the way in:
      password: Password.fromHashedValue(props.password as string),
      userType: UserTypeFactory.create(props.userType as string),
    }, id);
  }

  // Serialize value objects on the way out. Merged OVER the default
  // prototype-reflected row (last-write-wins):
  protected createPersistence(user: User): Partial<UserRow> {
    return {
      password_hash: user.password.getHashedValue(),
      user_type: user.userType.toString(),
    };
  }
}
```

### What `BasePersistenceMapper` handles for you

- **`id`** — read from `aggregate.id`, written to the `id` column.
- **`createdAt` / `updatedAt` / `insertedBy` / `updatedBy`** — inherited
  accessors on `Entity` are auto-discovered and mapped to their snake_case
  columns. You never declare them.
- **Every persisted domain property** — discovered via prototype reflection
  (any accessor with both `get` and `set`).
- **Column name resolution** — `columnOverrides[domainKey]` wins; otherwise
  defaults to `camelToSnake(domainKey)`.
- **Reverse lookup** on `toDomain` — inverts `columnOverrides` first, then
  falls back to `snakeToCamel(column)`.

### What `BasePersistenceMapper` does *not* do

- **Value object serialization** — a `Password` in `props` stays a
  `Password` on the output row unless `createPersistence` overrides the
  specific column with its scalar form.
- **Skip computed getters** — getters without setters are excluded
  automatically; no explicit opt-out needed.

### Caveats to be aware of

- Relies on **class prototype** accessors, not instance own-properties.
  Fine for idiomatic TypeScript class syntax (`get name() { ... }`).
- **Minification** can rename getter/setter identifiers in the consumer's
  backend build, which would break reflection. Standard Node.js backends
  don't minify TypeScript output — a non-issue unless you're deliberately
  minifying your class names. If that's your pipeline, implement
  `PersistenceMapper` directly instead of extending `BasePersistenceMapper`.

## Read-side queries

The read side is **projection-driven, not table-driven**. A single read DAO exposes as many query methods as the module needs, each building its own SQL — possibly over different tables, joins, aggregates, or views. There is no one-table-per-DAO rule.

Three pieces cooperate:

| Piece | Role |
| --- | --- |
| `SqlQueryBuilder<T>` | Fluent SQL builder. `.select / .from / .join / .groupBy / .where / .filters / .orderBy / .paginate / .build`. Immutable — each fluent call returns a new instance. |
| `ColumnResolver` | Translates domain vocabulary (camelCase, `scopeId`) to DB columns (snake_case, `tenant_id`) at build time. |
| `BaseReadDao` | Owns the resolver + builder factory. Exposes `qb<T>()`, `findOne<T>(q)`, `findMany<T>(q)`, `findPaginated<T>(q, page)`. |

And one optional add-on for HTTP controllers:

| Piece | Role |
| --- | --- |
| `createQueryParametersSchema` (`/query-schema`) | Zod-based: takes a base filter shape, generates a full validation + transform schema that parses `?name__contains=foo&createdAt__gte=...&sort=...&page=2` into a typed `StandardListQuery<TFilters>`. Opt-in sub-path with `zod` as optional peer. |

### A read DAO with two query methods

```ts
import { BaseReadDao, type PaginatedResult, type StandardListQuery } from '@quilla-be-kit/persistence';
import { PgSqlQueryBuilder } from '@quilla-be-kit/persistence/postgres';

type RoleDetailsReadModel = {
  id: string;
  name: string;
  description: string | null;
  permissions: readonly string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type RoleListReadModel = Pick<RoleDetailsReadModel, 'id' | 'name' | 'isActive' | 'createdAt'>;

type RoleListQuery = StandardListQuery<{
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
}>;

export class RoleReadDao extends BaseReadDao {
  getDetails(id: string, scopeId: string): Promise<RoleDetailsReadModel | null> {
    const q = this.qb<RoleDetailsReadModel>()
      .select(['id', 'name', 'description', 'permissions', 'isActive', 'createdAt', 'updatedAt'])
      .from('iam_roles')
      .filters({ id, scopeId })
      .build();
    return this.findOne<RoleDetailsReadModel>(q);
  }

  listPage(query: RoleListQuery, scopeId: string): Promise<PaginatedResult<RoleListReadModel>> {
    const page = query.pagination ?? { page: 1, pageSize: 20 };
    const q = this.qb<RoleListReadModel>()
      .select(['id', 'name', 'isActive', 'createdAt'])
      .from('iam_roles')
      .filters({ ...query.filters, scopeId })
      .orderBy(query.sort, {
        enforced: [{ scopeId: 'asc' }],
        defaults: [{ createdAt: 'desc' }],
      })
      .paginate(page)
      .build();
    return this.findPaginated<RoleListReadModel>(q, page);
  }
}
```

Wire it at the composition root:

```ts
import { PgReadDbAdapter, PgSqlQueryBuilder } from '@quilla-be-kit/persistence/postgres';

const roleReadDao = new RoleReadDao({
  adapter: new PgReadDbAdapter(db),
  builderFactory: (resolver) => new PgSqlQueryBuilder(resolver),
});
```

### Domain vocabulary in, snake_case out

You write columns in domain vocabulary (`createdAt`, `isActive`, `scopeId`). The builder resolves them through the `ColumnResolver` and emits the correct DB names **plus output aliases** so read models receive the domain shape straight back:

```ts
this.qb().select(['id', 'createdAt', 'isActive']).from('users').build();
// -> SELECT id, created_at AS "createdAt", is_active AS "isActive" FROM users
```

The same resolver applies to `.filters()`, `.orderBy()`, and `.groupBy()`. `this.findOne` / `findMany` return rows with the camelCase keys the read model expects — no more hand-written `'created_at as "createdAt"'` lists.

### The filter suffix DSL

`.filters({ ... })` accepts a flat object keyed by `field` or `field__operator`. The delimiter is double-underscore (`__`) to avoid collisions with field names that contain underscores. The same vocabulary is also available on write DAOs' `where` filters — see [Filtering on write DAOs](#filtering-on-write-daos) above for the write-side caveats.

| Operator | SQL | Available for |
| --- | --- | --- |
| `field` (bare) | `field = $n` (or `IS NULL` if value is `null`) | all kinds |
| `field__eq` | `field = $n`, always — `null` matches no row | code only |
| `field__ne` | `field <> $n` — `NULL` rows never match | code only |
| `field__contains` | `field ILIKE '%value%'`, with `%`, `_` and `\` in the value matched literally | string |
| `field__in` | `field = ANY($n)` | string, number, date, enum |
| `field__notIn` | `field <> ALL($n) OR field IS NULL` | string, number, date, enum |
| `field__notInStrict` | `field <> ALL($n)` — SQL `NOT IN`; `NULL` rows never match | code only |
| `field__gt` / `__gte` / `__lt` / `__lte` | `field > $n` etc. | number, date |
| `field__isNull` | `field IS NULL` (or `IS NOT NULL` if value is `false`) | all kinds |
| `field__isNotNull` | `field IS NOT NULL` (inverse of above) | all kinds |

"Code only" operators are available in `.filters(...)` and write-side `where` filters but are never accepted from HTTP query strings. They follow SQL's own comparison rules; the bare key and `__notIn` are the null-tolerant forms. An `__eq` on a timestamp matches only at the exact stored precision.

`undefined` values are skipped, so `filters({ name: opts.name })` composes cleanly when `opts.name` is optional (write-side predicate methods throw instead — see [Predicate writes](#predicate-writes--updateby--deleteby--findsingle)). Unknown operator suffixes throw at build time.

### Raw WHERE fragments for dialect-specific operators

When the suffix DSL isn't enough (JSONB containment, full-text search, custom functions), use `.where(sql, ...params)`. Positional `?` placeholders are rebased onto the builder's parameter sequence:

```ts
this.qb<TaskRow>()
  .from('tasks')
  .filters({ scopeId })
  .where('tags @> ?::jsonb', JSON.stringify(['urgent']))
  .where('assignees @> ?::jsonb', JSON.stringify([userId]))
  .build();
// -> WHERE tenant_id = $1 AND tags @> $2::jsonb AND assignees @> $3::jsonb
```

Each `.where()` call is ANDed with the rest. Never concatenate user input into the SQL string — pass it as a parameter.

### Joins

`.join(clause: string)` appends a raw JOIN clause verbatim. Call it once per join — multiple calls accumulate in declaration order:

```ts
this.qb<OrderSummaryRow>()
  .from('orders o')
  .join('LEFT JOIN customers c ON c.id = o.customer_id')
  .join('LEFT JOIN order_lines ol ON ol.order_id = o.id')
  .select(['o.id', 'o.created_at', 'c.name', 'ol.sku'])
  .filters({ 'o.scope_id': scopeId })
  .build();
```

**Column qualification.** When queries span multiple tables, qualify ambiguous column references in every builder call that touches column names — `.select()`, `.filters()`, `.where()`, `.groupBy()`, and `.orderBy()` all accept `'table.col'` expressions and pass them through without resolver lookup:

```ts
.select(['o.created_at'])           // table.col — passed through, no resolver
.select(['createdAt'])              // bare key — resolved via ColumnResolver
.select(['o.*'])                    // wildcard — passed through
.select(['COUNT(ol.id) AS "lineCount"'])  // pre-aliased expression — passed through
```

> **Qualified references are SQL space.** The builder holds one resolver — the aggregate's — so it can't sensibly keep mapping past the dot (a joined table may have its own naming or overrides). The rule is: bare `createdAt` is domain vocabulary and gets resolved; `o.createdAt` is SQL and emits `o.createdAt` verbatim, which Postgres will reject if the real column is `created_at`. Write `o.created_at` yourself once you've qualified. The asymmetry is silent at build time and surfaces only at query execution — qualify carefully.

`.from()` accepts an alias: `'orders o'` or `'orders AS o'`. Use an alias whenever you qualify columns so the alias propagates consistently through the rest of the query.

### Aggregations with GROUP BY

`.groupBy(columns: readonly string[])` adds a `GROUP BY` clause. Column keys are domain-vocabulary and resolved through the `ColumnResolver` the same way as `.select()`. Qualify with `'table.col'` when the query joins multiple tables:

```ts
this.qb<LineCountRow>()
  .from('orders o')
  .join('LEFT JOIN order_lines ol ON ol.order_id = o.id')
  .select(['o.id', 'o.created_at', 'COUNT(ol.id) AS "lineCount"'])
  .filters({ 'o.scope_id': scopeId })
  .groupBy(['o.id', 'o.created_at'])
  .build();
```

When `.paginate()` is also applied, the count wraps the grouped subquery automatically — you don't need to do anything extra.

### Pagination

`.paginate({ page, pageSize })` adds `LIMIT`/`OFFSET` and automatically emits a `countSql` alongside the data SQL. `findPaginated` runs both queries in parallel on the read pool and returns a `PaginatedResult<T>`:

```ts
const result = await dao.listPage(query, scopeId);
// { rows: [...], total: 137, page: 2, pageSize: 20 }
```

`distinctOn` is supported for Postgres:

```ts
.paginate({ page: 1, pageSize: 50, distinctOn: ['customerId'] })
// -> SELECT DISTINCT ON (customer_id) ... LIMIT 50 OFFSET 0
```

If the query uses `GROUP BY`, the count is computed over the grouped set via a subquery wrap — you don't need to do anything special.

When hand-constructing a `QueryProduct` with both `sql` and `countSql`, both queries receive the same `params` array — the caller is responsible for ensuring both are parametrically compatible.

### Single-row reads — `limit` and `findSingle`

`.limit(n)` adds a plain `LIMIT` (it can't be combined with `.paginate`).
`findSingle` runs a query that must match at most one row — `null` for none,
`TooManyRowsError` for more (`context.entity` is the DAO's class name).
Bound the query with `.limit(2)` so a wide match never loads more than the
two rows needed to detect it:

```ts
class AccountReadDao extends BaseReadDao {
  byEmail(email: string) {
    const q = this.qb<AccountRow>().from('accounts').filters({ email__eq: email }).limit(2).build();
    return this.findSingle<AccountRow>(q);
  }
}
```

### Sorting with enforced + default directives

`.orderBy(userSort, { enforced, defaults })` gives you three layers:

- **User sort** — from an HTTP query, or the `sort` on a `StandardListQuery`.
- **Enforced** — always applied, prepended to whatever user sort is there (use for scope-first stability, deterministic ordering across equal keys).
- **Defaults** — applied only when `userSort` is empty or absent.

```ts
.orderBy(query.sort, {
  enforced: [{ scopeId: 'asc' }],
  defaults: [{ createdAt: 'desc' }, { id: 'asc' }],
})
```

### `ColumnResolver` — mapping domain keys to your column names

Every `BaseReadDao` carries a `ColumnResolver`. The default is `DefaultColumnResolver`, which does camelCase → snake_case plus any explicit overrides you pass:

```ts
import { DefaultColumnResolver } from '@quilla-be-kit/persistence';

new DefaultColumnResolver({
  overrides: {
    scopeId: 'tenant_id',       // your column isn't called `scope_id`
    password: 'password_hash',
  },
});
```

Pass it to the DAO constructor:

```ts
new RoleReadDao({
  adapter: readAdapter,
  builderFactory: (r) => new PgSqlQueryBuilder(r),
  columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
});
```

Or, more commonly, bake the overrides into a **shell base class** once and every read DAO in your project inherits them (see the "Adopting the toolkit: build a shell" section in the root [README](../../README.md)):

```ts
export abstract class AppBaseReadDao extends BaseReadDao {
  constructor(adapter: ReadDbAdapter) {
    super({
      adapter,
      builderFactory: (r) => new PgSqlQueryBuilder(r),
      columnResolver: new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } }),
    });
  }
}
```

Then `extends AppBaseReadDao` everywhere and every query translates `scopeId` → `tenant_id` automatically.

### Quoting on the read side

`PgSqlQueryBuilder` emits identifiers unquoted by default. Pass
`quoteIdentifiers: true` and it double-quotes everything the resolver
produces, which is what makes mixed-case, space-containing and reserved-word
columns addressable:

```ts
new RoleReadDao({
  adapter: readAdapter,
  builderFactory: (r) => new PgSqlQueryBuilder(r, { quoteIdentifiers: true }),
  columnResolver: new DefaultColumnResolver({ overrides: { noteId: 'Note Id' } }),
});

// .filters({ noteId: 'x' })  →  WHERE "Note Id" = $1
// .select(['noteId'])        →  SELECT "Note Id" AS "noteId"
```

Quoted table names come from the structured `from` form, which takes the
parts separately so no string has to be parsed:

```ts
this.qb<Row>().from({ schema: 'legacy', table: 'Case Notes', alias: 'n' });
// FROM "legacy"."Case Notes" AS "n"
```

**What this does NOT do:**

- Quoting changes what the builder *emits*, never what it *accepts*. Input
  keys are held to the same identifier rules in both modes — you reach a
  non-plain column through a `ColumnResolver` override, and a non-plain table
  through `from({ ... })`, not by passing the raw name as a key.
- Qualified references (`u.id`, both in `select` and as filter keys) stay
  caller-owned and unquoted in both modes, as do `where()` and `join()`
  fragments.
- The string form of `from` (`'users u'`) stays unquoted even with the option
  on.
- Resolver *output* is never validated. With quoting **off**, an override
  emitting a non-plain name still produces invalid SQL — that is what the
  option fixes. With quoting **on**, output must be a raw column name: a
  resolver that deliberately emits an expression (`lower(name)`) would be
  quoted into a broken identifier.

### HTTP query string → validated DTO → read DAO

The `@quilla-be-kit/persistence/query-schema` sub-path provides `createQueryParametersSchema` — a Zod helper that generates the full validation + transform schema from a plain filter shape:

```ts
// application/queries/list-roles.query.ts
import type { StandardListQuery } from '@quilla-be-kit/persistence';

export type ListRolesFilters = {
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
};
export type ListRolesQuery = StandardListQuery<ListRolesFilters>;
```

```ts
// presentation/dto/list-roles.request-dto.ts
import { z } from 'zod';
import { createQueryParametersSchema } from '@quilla-be-kit/persistence/query-schema';
import type { ListRolesFilters } from '../../application/queries/list-roles.query.js';

const filters = z.object({
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.coerce.date().optional(),
}) as z.ZodObject<{ [K in keyof ListRolesFilters]: z.ZodType<ListRolesFilters[K]> }>;

export const ListRolesRequestDto = createQueryParametersSchema<ListRolesFilters>(filters, {
  defaultPageSize: 20,
  maxPageSize: 100,
});
```

```ts
// presentation/controllers/roles.controller.ts
@Controller('/roles')
export class RolesController {
  constructor(private readonly roleRead: RoleReadDao) {}

  @Get('/')
  @ValidateRequest(ListRolesRequestDto, ['query'])
  async list(req: ValidatedRequest<typeof ListRolesRequestDto>): Promise<HttpResponse> {
    const query = req.getValidatedInput();
    const ctx = req.getExecutionContext();
    const result = await this.roleRead.listPage(query, ctx.scopeId!);
    return HttpResponse.ok(result);
  }
}
```

A request like:

```
GET /roles?name__contains=admin&isActive=true&createdAt__gte=2026-01-01&sort=createdAt:desc&page=2&pageSize=50
```

becomes, by the time the controller's handler sees it:

```ts
{
  filters: {
    name__contains: 'admin',
    isActive: true,
    createdAt__gte: new Date('2026-01-01'),
  },
  sort: [{ createdAt: 'desc' }],
  pagination: { page: 2, pageSize: 50 },
}
```

The filter shape you declare drives the generated operator set automatically — string fields get `__contains` / `__in` / `__notIn` / `__isNull` / `__isNotNull`, numbers and dates add `__gt` / `__gte` / `__lt` / `__lte`, booleans get `__isNull` / `__isNotNull`, enum fields (`z.enum(...)`) get `__in` / `__notIn` / `__isNull` / `__isNotNull` (no `__contains` — substring match is semantically wrong for fixed-value sets). Unknown query keys are stripped. Sort directives pointing at unknown fields are dropped. `pageSize` is clamped to `maxPageSize`.

#### Strict vs tolerant parsing

By default the parser is **tolerant** — unknown keys, unknown sort fields, bad sort directions, and invalid `page` / `pageSize` values are silently normalized (dropped or replaced with defaults). That suits public HTTP endpoints where you'd rather serve a valid response with sensible defaults than 400 the caller for typos.

Opt into **strict** mode for trusted callers (internal RPC, background jobs) or when you want client bugs to surface loudly:

```ts
export const ListRolesRequestDto = createQueryParametersSchema<ListRolesFilters>(filters, {
  defaultPageSize: 20,
  maxPageSize: 100,
  strict: true,
});
```

In strict mode a request like `?unknown=x&sort=foo:sideways&page=-1` produces a single `ZodError` with one issue per problem: unknown key, unknown sort field, invalid sort direction, invalid page. `maxPageSize` stays a **clamp** even in strict mode — a client asking for more data than you're willing to serve isn't malformed input, just bounded.

#### Extra top-level fields (auth-derived identifiers, correlation ids, etc.)

Some queries need fields that belong on the **query envelope** but aren't client-narrowable filters — typically auth-derived identifiers the server populates post-validation (`scopeId`, `userId`, etc.). Putting those inside the filter shape would be wrong — the generator would auto-expand them into suffix operators (`scopeId__in`, `scopeId__contains`) and expose scope-crossing filters to the client.

Use the `extraFields` option to declare them at the top level of the generated schema instead. The generator:

- Declares them at the top level (so strict mode accepts them and doesn't reject as unknown).
- **Skips** suffix-operator expansion for their names.
- Passes them through to the transform output at the top level, alongside `filters` / `sort` / `pagination` — **not** nested under `filters`.

```ts
import { z } from 'zod';
import { createQueryParametersSchema } from '@quilla-be-kit/persistence/query-schema';

export const ListRolesRequestDto = createQueryParametersSchema<
  ListRolesFilters,
  { scopeId: string; userId: string }
>(filters, {
  strict: true,
  extraFields: z.object({
    scopeId: z.string().optional(),
    userId: z.string().optional(),
  }),
});
```

`@ValidateRequest` then populates `scopeId` / `userId` from the active `ExecutionContext` because the schema declares them — see [conditional auth-injection in `@quilla-be-kit/http`](../http/README.md#validaterequestschema-sources). Your consumer-side query type composes via intersection:

```ts
export type ListRolesQuery = StandardListQuery<ListRolesFilters> & {
  scopeId?: string;
  userId?: string;
};
```

Handler reads `query.scopeId` directly — no separate arg, no explicit stitch at the controller. The toolkit stays naming-agnostic: `scopeId` / `userId` are your choice (some apps call the boundary `tenantId`, `workspaceId`, etc.), and any field can flow through `extraFields`, not just auth identifiers.

The generator is Zod-bound (extracts field kinds by walking the `ZodObject` schema) but the output — `StandardListQuery<TFilters> & Partial<TExtra>` — is validator-agnostic. A Valibot or ArkType consumer can implement their own generator against the same output contract. Field descriptors are available via `fieldDescriptorsFromZod` for building alternative generators on top of Zod.

### Safety discipline

`.select()`, `.from()`, `.join()`, `.groupBy()`, `.orderBy()`, and `.filters()` validate identifiers with a strict regex — user input must **never** reach those seams. When you need a runtime value in a condition, it flows through `.where(sql, ?)` or `.filters({...})`, both of which parameterise. Raw user text should never be interpolated into a SQL string.

Consumer-facing consequences:

- `.from('users; invalid-sql')` throws at build time.
- `.select(['id', injectedFromUser])` throws if the user string isn't a plain identifier.
- `.where('name = ' + userInput)` — still your own bug. Always use `.where('name = ?', userInput)`.

### When to drop back to `ReadDbAdapter.select`

The builder covers the common projection shapes. For one-off reads where the builder is overkill, `ReadDbAdapter` retains its original `select({ table, where, limit, orderBy })` API for structured single-table selects, and `raw<T>(sql, params)` for anything else. Both are available on `this.adapter` inside a DAO. The builder path is the recommended default; the raw paths stay as honest escape hatches.

## Files

```
src/
├── database/     Database / DatabaseTransaction / DatabaseResult / DatabaseHealth
├── db-adapter/   FilterQuery, Read/Write/Routine DbAdapter interfaces + options,
│                 AUDIT_COLUMNS
├── dao/          BaseReadDao, BaseWriteDao, KeyedWriteDao, BaseRoutineDao,
│                 WriteDao / IdWriteDao contracts, ALL_ROWS, ActorProvider, AuditPolicy
├── query/        QueryProduct, PaginatedResult, StandardListQuery, FieldDescriptor,
│                 ColumnResolver + DefaultColumnResolver, SqlQueryBuilder
├── query-schema/ createQueryParametersSchema (Zod adapter — `/query-schema`)
├── unit-of-work/ UnitOfWork, UnitOfWorkContext, DomainEventSource, EventSink
├── repository/   KeyedBasicRepository, BaseBasicRepository (row repositories)
├── aggregate/    DDD layer — `/aggregate`: aggregate repositories, mappers,
│                 DDD-typed UnitOfWork / UnitOfWorkContext
├── errors/       CrossScopeAccessError, OptimisticLockError, TooManyRowsError
└── postgres/     PgDatabase, PgTransaction, PgWriteDbAdapter, PgReadDbAdapter,
                  PgRoutineDbAdapter, PgSqlQueryBuilder — `/postgres`
```

Each folder imports only from the layers below it; `tests/layers.test.ts`
enforces this and keeps `@quilla-be-kit/ddd` inside `aggregate/`.
