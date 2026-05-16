# @quilla-be-kit/observability

## 0.2.0

### Minor Changes

- 2bd37fe: Initial public surface: `Logger`, `LoggerFactory`, `LogFormatter`,
  `LogObserver`, `LogEntryEnricher`, `LogObfuscator` interfaces; `StructuredLogger`,
  `NoopLogger`, `JsonFormatter`, `PrettyFormatter`, `RecursiveObfuscator`
  implementations; `createLoggerFactory()` and `createRecursiveObfuscator()`
  factory functions.

  Key design decisions:

  - Typed `LogContext` with `scopeId` (not `tenantId`), `userId`, `actorType`,
    `correlationId`. Fields are optional and omitted when absent — no
    "unknown" sentinel values polluting aggregator dashboards.
  - Two-bucket payload: `data` is the PII bucket (obfuscated when a
    `LogObfuscator` is configured); `meta` is the operational bucket (always
    plain). Callers decide at the call site.
  - `RecursiveObfuscator` supports HMAC-SHA256 (stable pseudonym,
    correlation-friendly) and AES-GCM (reversible with `decryptValue` for
    incident response). Minimum secret length 32 characters.
  - Obfuscation failures replace `data` with `{ _obfuscationError: true }`
    rather than dropping the log — degrades gracefully and signals the
    failure in-band.
  - `LogEntry` drops the hardcoded `http` slot; HTTP-specific context goes
    under the generic `extra` bag via an HTTP enricher (shipped separately in
    `@quilla-be-kit/http` when that package is written). Observability stays
    Layer 0 with zero toolkit-internal dependencies.
  - `createLoggerFactory()` is a function, not a class. Matches the modern
    TypeScript ecosystem (Pino, Vitest, Zod, Drizzle, tRPC) and keeps
    tree-shaking and internal flexibility healthy.
  - `StructuredLogger` emits asynchronously (fire-and-forget from the caller's
    perspective) to allow non-blocking obfuscation. Exposes `flush()` for
    graceful shutdown.
  - Interfaces drop the `I` prefix (`Logger`, not `ILogger`) per TypeScript
    community convention.

- 7c86c48: `LoggerConfig.service` identifies the emitting service (microservice,
  backend, worker) on every log entry. Surfaces as a first-class top-level
  field in JSON output and as a `[service]` bracket in pretty output,
  preceding the module label. Propagates through `forMethod` and
  `withMeta` child loggers.

  Pretty format goes from `[module::location]` to
  `[service] [module::location]`.

  Messaging adapters no longer double-stamp their class name on the
  caller-provided logger: `OutboxForwarder` takes the logger as-is, and
  `EventConsumer` places its per-instance `consumerName` into the `meta`
  bucket (via `withMeta`) rather than in the location label — keeping
  `module` cleanly owned by the caller.

- 7c86c48: `Logger.withMeta(meta)` returns a child logger that merges `meta` into
  every emitted entry's `meta` bucket. Chains with `forMethod` orthogonally
  and composes across multiple `withMeta` calls. Per-call `params.meta`
  wins on key collisions. Useful for per-handler or per-request annotation
  (event id, correlation id, subject id) without threading through every
  call site.
