# @quilla-be-kit/observability

Structured logger with pluggable formatters, observers, enrichers, and
optional PII obfuscation for the `data` bucket.

Zero runtime dependencies. Uses only Node's built-in Web Crypto
(`crypto.subtle`) when obfuscation is enabled.

For the plugin seams in detail — enricher ordering and merge rules, the emit
pipeline, observers, formatters — see [Logger internals](https://github.com/quilla-kit/quilla-be-kit/blob/main/packages/observability/src/logger/README.md).

## Why this package exists

Every `@quilla-be-kit/*` service-side package needs a logger with a consistent
shape so logs can be queried and correlated across packages. This package
ships:

- A `Logger` interface with `debug/info/warn/error`, `forMethod(name)` for
  method-scoped child loggers, and `withMeta(meta)` for child loggers that
  bake persistent meta (event id, correlation id, subject id) into every
  emitted entry.
- Two built-in `LogFormatter`s — `JsonFormatter` (production aggregators)
  and `PrettyFormatter` (ANSI-colored dev output).
- `LogObserver` plugin hooks for shipping entries to Datadog / Splunk / Loki /
  test captures.
- `LogEntryEnricher` plugin hooks for contributing `context` (`scopeId` /
  `userId` / `actorType` / `correlationId` / `executionAttemptId`) and
  free-form `extra` fields.
- A two-bucket payload: `data` (PII, obfuscated when enabled) and `meta`
  (operational, always plain).
- `RecursiveObfuscator` with HMAC-SHA256 (stable pseudonym) or AES-GCM
  (reversible) strategies for GDPR / PII compliance.

Deliberately has no dependency on `@quilla-be-kit/execution-context` — the
execution-context enricher lives *there* to keep this package adoptable
standalone.

## Install

```sh
pnpm add @quilla-be-kit/observability
```

## Quick start

```ts
import { createLoggerFactory } from '@quilla-be-kit/observability';

const factory = createLoggerFactory({
  config: {
    service: 'my-backend',
    level: 'info',
    mode: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  },
});

const logger = factory.create('UserService');
logger.info('user created', { meta: { durationMs: 42 }, data: { email: 'a@b.c' } });
```

`service` is the emitting process identity (microservice, backend, worker).
It surfaces as a first-class field on every log entry so aggregators can
filter by emitter — `[service] [module::location] message` in pretty
output, and a top-level `service` key in JSON.

Three levels of identification compose:

| Level    | Field      | Set by                       | Example           |
| -------- | ---------- | ---------------------------- | ----------------- |
| service  | `service`  | `LoggerConfig.service`       | `my-backend`      |
| module   | `module`   | `factory.create(name)`       | `UserService`     |
| location | `location` | `logger.forMethod(name)`     | `createUser`      |

Add per-call or per-scope metadata with `withMeta`:

```ts
const scoped = logger.forMethod('createUser').withMeta({ requestId: 'r-1' });
scoped.info('ok');
// Every entry emitted through `scoped` carries { requestId: 'r-1' } in meta.
// Per-call meta wins on key collisions; child withMeta accumulates on top of parent.
```

## Enrichers

An enricher contributes fields to every entry without the call site knowing
about them — request correlation, scope, build info, trace ids. Register them
once on the factory; every logger it creates inherits them, children included.

```ts
import type { LogEnricherContribution, LogEntryEnricher } from '@quilla-be-kit/observability';

class BuildInfoEnricher implements LogEntryEnricher {
  constructor(private readonly buildSha: string) {}

  enrich(): LogEnricherContribution {
    return { extra: { buildSha: this.buildSha } };
  }
}

const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'json' },
  enrichers: [new BuildInfoEnricher(process.env.BUILD_SHA!)],
});
```

`enrich()` is synchronous and runs once per emitted entry — not once at
`create()` — so it observes the state active at the moment of the log call.
That is what lets an AsyncLocalStorage-backed enricher pick up per-request
context. Keep it a field read, never I/O.

Contributions land in one of two places:

- **`context`** is typed as `Partial<LogContext>` — the shared correlation
  vocabulary (`scopeId`, `userId`, `actorType`, `correlationId`,
  `executionAttemptId`) that every `@quilla-be-kit` package agrees on.
- **`extra`** is an open record with its own top-level field, for
  consumer-specific ambient values.

Multiple enrichers merge in registration order, last wins on key collisions.
A throwing enricher is caught and skipped — the entry still emits.

For per-request scope and correlation, use `ExecutionContextEnricher` from
[`@quilla-be-kit/execution-context`](https://github.com/quilla-kit/quilla-be-kit/tree/main/packages/execution-context),
which bridges the active `ExecutionContext` onto every log line:

```ts
const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'json' },
  enrichers: [new ExecutionContextEnricher(provider)],
});
```

Ordering, merge rules, `context` vs `extra` guidance, and the rest of the
emit pipeline are documented in [Logger internals](https://github.com/quilla-kit/quilla-be-kit/blob/main/packages/observability/src/logger/README.md).

## With obfuscation (PII protection)

```ts
import { createLoggerFactory, createRecursiveObfuscator } from '@quilla-be-kit/observability';

const obfuscator = await createRecursiveObfuscator({
  strategy: 'hmac',           // 'hmac' (stable pseudonym) or 'encrypt' (reversible)
  secretKey: process.env.LOG_OBFUSCATION_SECRET!,   // must be >=32 chars
});

const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'json' },
  obfuscator,
});

const logger = factory.create('UserService');
logger.info('user created', {
  data: { email: 'a@b.c', phone: '555-0100' }, // <-- values get HMAC-ed
  meta: { durationMs: 42 },                    // <-- stays plain
});
```

The `data` bucket is the designated PII carrier. Keys are preserved; leaf
values (strings, numbers, booleans) are replaced with their HMAC or ciphertext.
`message`, `context`, `extra`, `meta`, and `error` are never obfuscated.

## API

### Interfaces
- `Logger` — the core contract
- `LoggerFactory` — returned by `createLoggerFactory()`
- `LogFormatter` — `format(entry) => string`
- `LogObserver` — `onEntry(entry)`
- `LogEntryEnricher` — `enrich() => { context?, extra? }`
- `LogObfuscator` — `obfuscate(data) => Promise<data>`
- `LogErrorSerializer` — `serialize(error) => SerializedError | undefined`

### Types
- `LogLevel`, `LogOutputMode`, `LogParams`, `LogContext`, `LogEntry`,
  `SerializedError`, `LoggerConfig`, `LoggerFactoryOptions`,
  `LogEnricherContribution`, `LogObfuscationStrategy`,
  `RecursiveObfuscatorOptions`

### Classes and functions
- `StructuredLogger` — default `Logger` impl. Has `flush()` for graceful
  shutdown.
- `NoopLogger` — silent, for tests.
- `JsonFormatter`, `PrettyFormatter` — bundled formatters.
- `RecursiveObfuscator` — default `LogObfuscator` impl.
- `createLoggerFactory(opts)` — construct a factory.
- `createRecursiveObfuscator(opts)` — async; imports the `CryptoKey` once.
- `decryptValue(ciphertext, key)` — incident-response reversal for `'encrypt'`
  strategy. Not for hot paths.

### Decrypting obfuscated values

When the `'encrypt'` strategy is in use, individual leaf values stored in
logs are `ENCRYPTED(...)` strings. To recover the plaintext during an
incident or audit, derive the same `CryptoKey` from the secret and call
`decryptValue`:

```ts
import { decryptValue, importObfuscationKey } from '@quilla-be-kit/observability';

const key = await importObfuscationKey('encrypt', process.env.LOG_OBFUSCATION_SECRET!);
const plaintext = await decryptValue('ENCRYPTED(AAAA...base64...)', key);
```

`decryptValue` throws if the input is not in `ENCRYPTED(...)` format. It
only works with the `'encrypt'` strategy — HMAC values (`'hmac'`) are
one-way pseudonyms and cannot be reversed.

## Graceful shutdown

Emission is internally async (so obfuscation and enrichment can run without
blocking the caller). The public `debug`/`info`/`warn`/`error` methods are
fire-and-forget. Before process exit, call `flush()` to await any in-flight
emissions:

```ts
import { StructuredLogger } from '@quilla-be-kit/observability';

// flush() lives on StructuredLogger, not the Logger interface —
// the interface is deliberately minimal. Narrow the type when you need it:
await (logger as StructuredLogger).flush();
```

Or register it with `@quilla-be-kit/runtime`'s `ShutdownManager` so it runs
automatically in the shutdown phase.

## Testing

`NoopLogger` is a silent implementation of `Logger` — use it in tests and
in code paths that opt out of logging without threading `| undefined`
through every call site:

```ts
import { NoopLogger } from '@quilla-be-kit/observability';

const logger = new NoopLogger();
// logger.info(...) etc. are no-ops; forMethod/withMeta return the same instance.
```

## Error serialization

By default `StructuredLogger` serializes errors using the standard `Error`
properties (`name`, `message`, `stack`, `cause`). Pass a `LogErrorSerializer`
to expose richer fields — for example the `code` and `context` carried by
`@quilla-be-kit/errors`:

```ts
import { createLoggerFactory } from '@quilla-be-kit/observability';
import { QuillaErrorSerializer } from '@quilla-be-kit/errors';

const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'pretty' },
  errorSerializer: new QuillaErrorSerializer(),
});
```

With this in place, a `NotFoundError` logged via `logger.error('…', err)`
produces:

```
  NotFoundError [NOT_FOUND]: User not found
  context: {"id":"u-123"}
    at ...
```

`serialize()` returns `undefined` for values the serializer does not handle;
`StructuredLogger` falls back to its built-in logic in that case, so plain
`Error` instances keep working without any extra wiring.

Implement `LogErrorSerializer` to integrate any other error hierarchy:

```ts
import type { LogErrorSerializer, SerializedError } from '@quilla-be-kit/observability';

class MyErrorSerializer implements LogErrorSerializer {
  serialize(error: unknown): SerializedError | undefined {
    if (!(error instanceof MyBaseError)) return undefined;
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      context: error.details,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }
}
```

## Design notes

- **Optional fields are omitted when absent**, not filled with sentinel strings.
  JSON output varies by entry shape — this is the standard for Datadog / Splunk /
  Loki and lets you query `correlationId:*` for scoped-only entries.
- **Enricher errors are silently swallowed.** Logging must never surface errors
  to the caller.
- **Observer errors are silently swallowed** for the same reason.
- **Obfuscation failures** are recorded in-band: the `data` field becomes
  `{ _obfuscationError: true }` instead of dropping the entry. You still get
  the log; you know something's wrong.
- **No I-prefix on interfaces.** `Logger`, `LoggerFactory`, `LogObserver` —
  TypeScript's structural typing does not benefit from Hungarian notation.
