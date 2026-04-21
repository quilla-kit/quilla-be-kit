# @quilla-kit/persistence

Persistence primitives: `Database` abstraction, `ReadDbAdapter` /
`WriteDbAdapter` for CQRS-isolated dialect adapters, DAOs with audit
injection and optimistic locking, aggregate repositories with scope
isolation, and a `UnitOfWork` with pluggable outbox.

Ships a **Postgres reference implementation** under
`@quilla-kit/persistence/postgres` — `PgDatabase`, `PgTransaction`,
`PgWriteDbAdapter` (with info-schema cache + JSONB / UUID / timestamp
casts), `PgReadDbAdapter`. Works with the `pg` package (optional peer dep).

Peer deps: `@quilla-kit/ddd`, `@quilla-kit/execution-context`,
`@quilla-kit/errors`. `pg` is an optional peer — required only if you
import from `/postgres`.

## Install

```sh
# Core:
pnpm add @quilla-kit/persistence @quilla-kit/ddd @quilla-kit/execution-context @quilla-kit/errors

# Plus Postgres adapter:
pnpm add pg
```

## Architectural invariants

- **Scope isolation is repo-layer explicit.** `BaseScopedAggregateRepository`
  takes `scopeId` on every load and throws `CrossScopeAccessError` on miss
  or mismatch. DAOs never inject `scope_id` implicitly.
- **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by`
  resolve from `ExecutionContextProvider` on every write. Callers cannot
  pass them; rows with audit fields in them get stripped.
- **Optimistic locking is opt-in via `updated_at`.** Include `updated_at`
  in the row passed to `update()` and the DAO asserts `rowCount === 1` —
  mismatch throws `OptimisticLockError`. Omit to update unconditionally.
- **Outbox is orthogonal, not built-in.** Wire an `OutboxWriter` on
  `UnitOfWork` to drain aggregate events + registered integration events
  in the same transaction. Omit for apps that don't use outbox.
- **Nested `transaction()` calls JOIN** — inner call sees the outer
  `UnitOfWorkContext` (via AsyncLocalStorage) and reuses the trx.
- **CQRS isolation at the type level.** `ReadDbAdapter` exposes only
  `select`; `WriteDbAdapter` exposes `insert`/`update`/`delete`/`find`/
  `findForUpdate`/`exists`. A single physical class can implement both
  interfaces for wiring convenience, but DAO-facing types enforce the
  boundary. **Read DAOs never accept a `trx` parameter** — reads don't
  participate in write transactions.
- **Pre-create uniqueness checks use the write side's unlocked reads**
  (`findOne` / `existsBy` on `BaseWriteDao`), not the read side. Locked
  reads (`findOneForUpdate`) are for read-before-update only.

## Vocabulary

- **DAO** layer — verb `find*`. Returns raw `TRow` from the database.
- **Repository** layer — verb `load*`. Returns `TAggregate` mapped from
  rows. The verb split marks the layer.

## Minimal usage (with Postgres)

```ts
import {
  BasePersistenceMapper,
  BaseScopedAggregateRepository,
  BaseWriteDao,
  UnitOfWork,
} from '@quilla-kit/persistence';
import {
  PgDatabase,
  PgReadDbAdapter,
  PgWriteDbAdapter,
} from '@quilla-kit/persistence/postgres';

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
const writeAdapter = new PgWriteDbAdapter(db);
const readAdapter  = new PgReadDbAdapter(db);
const uow = new UnitOfWork({ db, outboxWriter });

const userDao  = new UserDao(writeAdapter, contextProvider);
const userRepo = new UserRepository(new UserMapper(), userDao);

// 5. Use:
await uow.transaction(async (ctx) => {
  const user = await userRepo.loadForUpdateByIdAndScopeOrFail(
    userId, scopeId, ctx,
  );
  user.changeName('Alice');
  await userRepo.update(user, ctx);
  // Domain events drained to outbox, trx committed atomically.
});

// Pre-create uniqueness check — unlocked read on the write side:
await uow.transaction(async (ctx) => {
  if (await userDao.existsBy({ email: input.email }, ctx.trx)) {
    throw new DuplicateEmailError({ email: input.email });
  }
  await userRepo.create(newUser, ctx);
});

// Pool lifecycle: register with @quilla-kit/lifecycle:
shutdown.addPhase({
  name: 'database',
  participants: [{ name: 'PgDatabase', dispose: () => db.disconnect() }],
});
```

## Mappers — row ↔ aggregate conversion

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

### Mapper — minimum boilerplate case (pure snake_case)

When every domain property name maps cleanly to its snake_case column
(e.g. `adminEmail` ↔ `admin_email`), the mapper is just one method:

```ts
import { BasePersistenceMapper } from '@quilla-kit/persistence';

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

## Files

```
src/
├── database/     Database / DatabaseTransaction / DatabaseResult / DatabaseHealth
├── db-adapter/   FilterQuery, Read/Write DbAdapter interfaces + options
├── dao/          BaseReadDao, BaseWriteDao
├── repository/   BaseBasic/Aggregate/Scoped/Unscoped repositories + mapper
├── unit-of-work/ UnitOfWork, UnitOfWorkContext, OutboxWriter
├── errors/       CrossScopeAccessError, OptimisticLockError
└── postgres/     PgDatabase, PgTransaction, PgWriteDbAdapter, PgReadDbAdapter
```
