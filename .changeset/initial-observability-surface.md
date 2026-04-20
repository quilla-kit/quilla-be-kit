---
"@quilla-kit/observability": minor
---

Initial public surface: `Logger`, `LoggerFactory`, `LogFormatter`,
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
  `@quilla-kit/http` when that package is written). Observability stays
  Layer 0 with zero toolkit-internal dependencies.
- `createLoggerFactory()` is a function, not a class. Matches the modern
  TypeScript ecosystem (Pino, Vitest, Zod, Drizzle, tRPC) and keeps
  tree-shaking and internal flexibility healthy.
- `StructuredLogger` emits asynchronously (fire-and-forget from the caller's
  perspective) to allow non-blocking obfuscation. Exposes `flush()` for
  graceful shutdown.
- Interfaces drop the `I` prefix (`Logger`, not `ILogger`) per TypeScript
  community convention.
