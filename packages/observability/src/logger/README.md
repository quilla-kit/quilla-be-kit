# Logger internals

Deep dive on the pieces under `src/logger/`. The [package
README](../../README.md) covers the everyday surface — factory config,
`forMethod` / `withMeta`, obfuscation, error serialization. This file covers
the plugin seams: what runs when, in what order, and what the merge rules
are.

## Anatomy of an entry

`StructuredLogger.emit()` assembles a `LogEntry` from five sources:

| Field       | Comes from                                          |
| ----------- | --------------------------------------------------- |
| `service`   | `LoggerConfig.service`                              |
| `module`    | `factory.create(module)`                            |
| `location`  | `logger.forMethod(name)`                            |
| `context`   | enrichers' `contribution.context`                   |
| `extra`     | enrichers' `contribution.extra`                     |
| `data`      | `params.data` — the PII bucket, obfuscated when enabled |
| `meta`      | `params.meta` merged over `withMeta` baseline       |
| `error`     | the thrown value, via `LogErrorSerializer`          |

`context` is always present (possibly `{}`); `extra`, `data`, `meta`, and
`error` are omitted entirely when they have no content.

## Enrichers

An enricher contributes fields to every entry without the call site knowing
about them. This is how ambient state — request correlation, scope, tenant,
trace ids — reaches logs without being threaded through every signature.

```ts
export type LogEnricherContribution = {
  readonly context?: Partial<LogContext>;
  readonly extra?: Record<string, unknown>;
};

export interface LogEntryEnricher {
  enrich(): LogEnricherContribution;
}
```

Register them once on the factory; every logger it creates shares the array,
and `forMethod` / `withMeta` children inherit it:

```ts
const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'json' },
  enrichers: [new ExecutionContextEnricher(provider), new BuildInfoEnricher()],
});
```

### `context` vs `extra`

Two destinations, and the choice matters:

- **`context`** is typed — `Partial<LogContext>`, so `scopeId`, `userId`,
  `actorType`, `correlationId`, `executionAttemptId` and nothing else. These
  are the correlation fields every `@quilla-be-kit` package agrees on, which
  is what makes cross-package log queries work. Adding a key here means
  widening `LogContext` in this package.
- **`extra`** is an open `Record<string, unknown>` and lands in its own
  top-level `extra` field. This is where consumer-specific ambient fields go
  (`region`, `buildSha`, `podName`) with no coordination cost.

Reach for `extra` unless the field is genuinely part of the shared
correlation vocabulary.

### Timing and ordering

- `enrich()` is **synchronous**. It runs on the emit path; keep it a field
  read, not I/O. If you need async data, cache it outside and read the cache.
- It is called **once per emitted entry**, not once at `create()`. An
  enricher therefore observes the state active at the moment of the log call
  — which is exactly what makes AsyncLocalStorage-backed context work.
- It runs **after** the level check, so entries filtered out by
  `config.level` cost nothing.
- Contributions merge in **registration order, last wins** on key
  collisions. `context` and `extra` merge independently; a later enricher
  overwriting `correlationId` does not disturb another's `extra` keys.
- Enrichment happens **before** obfuscation, and neither `context` nor
  `extra` is ever obfuscated — only `data` is. Never route PII through an
  enricher.

### Errors are swallowed

A throwing enricher is caught and skipped; the entry is still emitted with
whatever the other enrichers contributed. Logging must never surface errors
to the caller — an observability bug should not become an application bug.
The corollary is that a broken enricher fails silently, so test enrichers
directly rather than relying on log output to reveal them.

### Writing one

```ts
import type { LogEnricherContribution, LogEntryEnricher } from '@quilla-be-kit/observability';

export class BuildInfoEnricher implements LogEntryEnricher {
  constructor(private readonly buildSha: string) {}

  enrich(): LogEnricherContribution {
    return { extra: { buildSha: this.buildSha } };
  }
}
```

An enricher reading ambient state returns an empty contribution rather than
throwing when that state is absent — bootstrap logs, scheduler ticks, and
pre-auth middleware all emit outside any request scope and must still
succeed:

```ts
enrich(): LogEnricherContribution {
  const span = tracer.getActiveSpan();
  return span ? { extra: { traceId: span.traceId } } : {};
}
```

### The execution-context bridge

`ExecutionContextEnricher` ships in
[`@quilla-be-kit/execution-context`](../../../execution-context/README.md),
not here — this package deliberately has no dependency on it, so the logger
stays adoptable standalone. It reads the active `ExecutionContext` and
contributes `scopeId`, `userId` (both from `ctx.session`, when present),
`actorType`, `correlationId`, and `executionAttemptId`.

## Observers

```ts
export interface LogObserver {
  onEntry(entry: LogEntry): void;
}
```

Observers receive the finished entry — after enrichment, after obfuscation,
after error serialization — and are the seam for shipping to Datadog /
Splunk / Loki, or for capturing entries in tests. Like enrichers, they are
registered on the factory, called on every emitted entry, and have their
errors swallowed.

An observer sees the *obfuscated* `data`, which is the point: it cannot leak
what the formatter would not have printed.

## Formatters

```ts
export interface LogFormatter {
  format(entry: LogEntry): string;
}
```

Exactly one formatter is active, chosen by `config.mode` (`json` →
`JsonFormatter`, `pretty` → `PrettyFormatter`) unless `opts.formatter`
overrides it. `JsonFormatter` emits one line per entry for aggregators;
`PrettyFormatter` emits ANSI-colored `[service] [module::location] message`
for local development.

## Why `emit()` is async

Obfuscation uses Web Crypto, which is promise-based. Rather than block the
caller, `debug` / `info` / `warn` / `error` are fire-and-forget: they
schedule the emission and return. `StructuredLogger` tracks in-flight
promises so `flush()` can await them before process exit.

`flush()` lives on `StructuredLogger`, not on the `Logger` interface —
the interface stays minimal so `NoopLogger` needs no counterpart. Narrow the
type, or register the flush with `@quilla-be-kit/runtime`'s
`ShutdownManager`.

## File map

| File | Role |
| --- | --- |
| `logger.interface.ts` | `Logger`, `LogParams` — the core contract |
| `logger.factory.ts` | `createLoggerFactory`, `LoggerConfig`, `LoggerFactoryOptions` |
| `structured.logger.ts` | default impl; owns the emit pipeline and `flush()` |
| `noop.logger.ts` | silent impl for tests and opt-out paths |
| `log-entry.type.ts` | `LogEntry`, `LogContext`, `LogLevel`, `SerializedError` |
| `log-entry.enricher.ts` | `LogEntryEnricher`, `LogEnricherContribution` |
| `log.observer.ts` | `LogObserver` |
| `log.formatter.ts` | `LogFormatter` |
| `json.formatter.ts` / `pretty.formatter.ts` | bundled formatters |
| `log-error-serializer.interface.ts` | `LogErrorSerializer` |
| `obfuscation/` | `LogObfuscator`, `RecursiveObfuscator`, key/crypto helpers |
