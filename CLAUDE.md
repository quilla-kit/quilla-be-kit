# Conventions for Claude working on this codebase

This file captures decisions that have been made on this project. Follow them
by default unless explicitly asked to revisit.

## Source-folder organization

**Do not create a subfolder unless it has a reason to exist.** A subfolder with
1–2 tiny files is not organization — it's proliferating tree noise.

Concretely:

- Start with fewer, bigger folders. A single folder with 10–15 focused files is
  usually easier to navigate than six folders with two files each.
- Only create a subfolder when a **sub-topic emerges** — a cluster of files that
  share an internal concern the rest of the folder doesn't, typically 3+ files.
- Nest sub-topics within their parent topic rather than hoisting them to the
  root of `src/`. For example, obfuscation is a sub-topic of the logger, so it
  lives at `src/logger/obfuscation/` — not at `src/obfuscation/`.

**Bad** (what we had after scaffolding observability the first time):

```
src/
├── enrichers/          (1 file)
├── factory/            (1 file)
├── formatters/         (3 files)
├── logger/             (3 files)
├── obfuscation/        (3 files)
├── observers/          (1 file)
├── log-entry.ts
└── index.ts
```

**Good**:

```
src/
├── logger/
│   ├── obfuscation/    (a real sub-topic within logger)
│   ├── json.formatter.ts
│   ├── log-entry.type.ts
│   ├── log.formatter.ts
│   ├── log.observer.ts
│   ├── log-entry.enricher.ts
│   ├── logger.factory.ts
│   ├── logger.interface.ts
│   ├── noop.logger.ts
│   ├── pretty.formatter.ts
│   ├── structured.logger.ts
│   └── index.ts
└── index.ts
```

## Source file naming

Files follow the shape **`{subject}.{type}.ts`** where:

- **`{type}`** is the single-word role suffix — always simple, never compound.
  Current vocabulary: `provider`, `factory`, `formatter`, `event`, `metadata`,
  `enricher`, `observer`, `obfuscator`, `logger`, `entry`, `aggregate`, `root`,
  `error`, `repository`, `dao`, `manager`, `phase`, `result`, `transaction`,
  `writer`, `context`, `mapper`, `interface`, `type`.
- Use **`.interface.ts`** when the file's main export is a TypeScript
  `interface` (contract to be implemented by a class) and no more specific
  role fits (e.g. prefer `.provider.ts` or `.writer.ts` if accurate).
- Use **`.type.ts`** when the file's main export is a pure data `type`
  (union, mapped type, record shape) and no more specific role fits.
- **`{subject}`** is everything before the dot. May contain hyphens for
  multi-word subjects (`execution-context`, `async-execution-context`,
  `log-entry`).

**Examples:**

| File | Subject | Type |
| --- | --- | --- |
| `domain.event.ts` | `domain` | `event` |
| `integration.event.ts` | `integration` | `event` |
| `event.metadata.ts` | `event` | `metadata` |
| `execution-context.provider.ts` | `execution-context` | `provider` |
| `async-execution-context.provider.ts` | `async-execution-context` | `provider` |
| `execution-context.enricher.ts` | `execution-context` | `enricher` |
| `log-entry.enricher.ts` | `log-entry` | `enricher` |
| `structured.logger.ts` | `structured` | `logger` |
| `recursive.obfuscator.ts` | `recursive` | `obfuscator` |
| `root.aggregate.ts` | `root` | `aggregate` |
| `database.interface.ts` | `database` | `interface` |
| `database-transaction.interface.ts` | `database-transaction` | `interface` |
| `filter-query.type.ts` | `filter-query` | `type` |
| `shutdown.manager.ts` | `shutdown` | `manager` |
| `outbox-writer.interface.ts` | `outbox-writer` | `interface` |

**Do not use compound type suffixes.** Never `context-provider`,
`context-enricher`, or `entry-enricher` as the type segment. Flatten to the
simple role and let the subject carry the qualification. Same role gets the
same type suffix everywhere.

**Files that stay single-word** (no subject/type split): `entity.ts`,
`envelope.ts`, `crypto.ts`, `unit-of-work.ts`, plus every package's
`index.ts`. Reserved for files whose main export is a class with no
specific role suffix that fits, and that anchors the package's vocabulary
(the base type everything else describes). Pure type or interface files
always take `.type.ts` or `.interface.ts` — even when they are the
package's central concept (prefer `logger.interface.ts` over `logger.ts`,
`execution-context.type.ts` over `execution-context.ts`).

**Test files mirror** the source name with `.test.ts` appended:
`domain.event.ts` → `domain.event.test.ts`.

## Tests

Tests live in a dedicated `tests/` folder at the package root, mirroring the
`src/` layout. They do **not** co-locate with source.

```
packages/foo/
├── src/feature/thing.ts
└── tests/feature/thing.test.ts
```

Each package that has tests needs a `tsconfig.test.json` that extends the
package's `tsconfig.json` with `composite: false`, `noEmit: true`, and
`include: ["src/**/*", "tests/**/*"]`. Wire the script `"typecheck": "tsc -p
tsconfig.test.json"`. Turbo's `typecheck` task runs it; CI runs `pnpm typecheck`
between `pnpm build` and `pnpm test`.

Shared fixtures and helpers go in `tests/helpers/` or `tests/fixtures/`.

## `interface` vs `type`

- Use `interface` **only** when the shape is designed to be implemented by a
  class (`class Foo implements Bar`) or when declaration merging is intended.
- Use `type` for everything else: pure data shapes, `*Props`, `*JSON`,
  `*Options`, unions, mapped types, function aliases.

Examples in this repo:

- `interface Logger`, `interface LoggerFactory`, `interface LogObserver`,
  `interface LogEntryEnricher`, `interface LogFormatter`,
  `interface LogObfuscator` — all have method signatures that classes implement.
- `type LogEntry`, `type LogContext`, `type LogParams`, `type LoggerConfig`,
  `type LoggerFactoryOptions`, `type BaseEntityProps`, `type DomainEventJSON` —
  pure data.

## No `I`-prefix on interface names

TypeScript is structurally typed; `I`-prefix is Hungarian notation that the
type system already encodes. No `ILogger` / `IEventBus` / `IExecutionContext`.
Just `Logger`, `EventBus`, `ExecutionContext`.

Per the [TypeScript team's coding guidelines](https://github.com/microsoft/TypeScript/wiki/Coding-guidelines).

## Scope naming

Use `scopeId` (not `tenantId`). The toolkit is naming-agnostic about what the
scope represents — consumers choose whether it's a tenant, workspace,
organization, project, etc. This is an architectural invariant, documented in
the root [README.md](README.md).

Related names: `CrossScopeAccessError`, `BaseScopedAggregateRepository`,
column default `scope_id`.

## ESM + `.js` extensions in source

All packages are pure ESM. `tsconfig.base.json` uses `"moduleResolution":
"NodeNext"`, which requires explicit file extensions on relative imports.

Write `.js` extensions in source even though the files are `.ts`:

```ts
import { Entity } from './entity.js';   // resolves to ./entity.ts at type-check time
```

This is the official TypeScript + Node ESM convention. Don't fight it.

## Interface packages have zero runtime deps

Interface packages (`@quilla-be-kit/ddd`, `lifecycle`, `observability`,
`execution-context`, `http`, `persistence`, `messaging`, `runtime`) must have
zero external runtime dependencies. Platform-level built-ins (`node:crypto`,
etc.) are fine. Concrete transport/storage drivers (`hono`, `pg`) belong in
consumer projects.

## Style and formatting

- **Biome** handles lint + format. `pnpm lint` runs `biome check .`,
  `pnpm format` writes fixes.
- **Single quotes** for strings, **semicolons** always, **trailing commas** in
  all positions. Enforced by Biome; don't fight it.
- Default to **no comments**. Only add a comment when the *why* is non-obvious
  (hidden constraint, subtle invariant, workaround for a specific bug). Never
  write multi-paragraph docstrings or narrate what the code does.

## Async emission in loggers

`StructuredLogger.emit()` is async so obfuscation can run without blocking the
caller. Public methods (`debug`/`info`/`warn`/`error`) are fire-and-forget.
Before process exit, call `logger.flush()` to await in-flight emissions.
`NoopLogger` has no `flush()` — nothing to wait for.

## Changesets

Every PR that changes published behavior of a `@quilla-be-kit/*` package adds a
changeset. Independent versioning per package — adapters evolve out-of-lockstep
with interfaces.

Pre-1.0, all real feature releases are `minor` bumps (0.1.0 → 0.2.0).
Patches are patch bumps.

## Commit messages

Conventional-commits-style. Scope with the affected package (`feat(ddd):`,
`feat(observability):`, `chore:`, `docs:`). Body explains the *why* and the
load-bearing design decisions, not a file list.
