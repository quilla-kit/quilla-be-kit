# @quilla-kit/errors

Transport-agnostic error primitives: `QuillaError` abstract base with a
cross-realm-safe brand, plus concrete category classes consumers extend or
throw directly.

Zero runtime dependencies.

## Install

```sh
pnpm add @quilla-kit/errors
```

## Categories

```ts
import {
  QuillaError,      // abstract base — brand carrier + toJSON
  ValidationError,  // VALIDATION   — bad input
  NotFoundError,    // NOT_FOUND    — resource missing
  ConflictError,    // CONFLICT     — duplicate, optimistic lock, state clash
  UnauthorizedError,// UNAUTHORIZED — no / bad credentials
  ForbiddenError,   // FORBIDDEN    — authorized but not allowed
  InternalError,    // INTERNAL     — known internal failure
  ExternalError,    // EXTERNAL     — downstream service failed
  UnknownError,     // UNKNOWN      — unrecognized thrown value (extends InternalError)
} from '@quilla-kit/errors';
```

## Usage

Throw a category class directly, or extend it for a specific leaf:

```ts
// Ad-hoc:
throw new NotFoundError({ message: 'User not found', context: { id } });

// Domain-specific leaf — code is immutable per class:
class CrossScopeAccessError extends NotFoundError {
  override readonly code = 'CROSS_SCOPE_ACCESS';
  constructor(opts: { entity: string; id: string; scopeId: string }) {
    super({
      message: `${opts.entity} with id ${opts.id} not found in scope`,
      context: opts,
    });
  }
}
```

### Why `code` is immutable

Each concrete class assigns a `readonly code` at class level and subclasses
override it. The category+code pair is what the classification pattern
below keys on — runtime mutation would break `instanceof` guarantees and
the serialized `toJSON()` shape. Always use `override readonly code = '...'`
for domain-specific leaves.

### Chaining causes (ES2022)

Use the native `cause` property to preserve the underlying failure when
wrapping low-level errors into a domain category:

```ts
try {
  await dependency.call();
} catch (err) {
  throw new ExternalError({
    message: 'Payment provider unreachable',
    context: { providerId },
    cause: err,  // serialized into toJSON().cause as a string
  });
}
```

`cause` flows through to `toJSON()` for structured logs. Log aggregators
see the wrapped category (with the user-safe message) *and* the underlying
cause string in one record.

## Classification

Use `QuillaError.is(e)` as the cross-realm-safe boundary check, then
`instanceof` for category matching:

```ts
function toHttpStatus(e: unknown): number {
  if (!QuillaError.is(e)) return 500;
  if (e instanceof ValidationError)   return 400;
  if (e instanceof UnauthorizedError) return 401;
  if (e instanceof ForbiddenError)    return 403;
  if (e instanceof NotFoundError)     return 404;
  if (e instanceof ConflictError)     return 409;
  if (e instanceof ExternalError)     return 502;
  return 500;
}
```

- `QuillaError.is()` uses `Symbol.for('quilla-kit.error')` — works across
  module-system realms (e.g. duplicate package copies).
- `instanceof` works within a single realm and is inheritance-aware
  (`CrossScopeAccessError` matches `instanceof NotFoundError`).
- To keep `instanceof` reliable, downstream packages should declare
  `@quilla-kit/errors` as a `peerDependency`.

## Serialization

```ts
err.toJSON();
// { name: 'NotFoundError', code: 'NOT_FOUND', message: '…', context?: {…}, cause?: … }
```

Safe for structured logging. `message` is the public, end-user-safe string;
internal debug detail goes in `context`.

## Logger integration

`QuillaErrorSerializer` bridges `@quilla-kit/errors` into
`@quilla-kit/observability`'s `LogErrorSerializer` contract. Wire it once at
the factory level and every `logger.error(msg, err)` call will surface `code`
and `context` in the log entry:

```ts
import { createLoggerFactory } from '@quilla-kit/observability';
import { QuillaErrorSerializer } from '@quilla-kit/errors';

const factory = createLoggerFactory({
  config: { service: 'my-backend', level: 'info', mode: 'pretty' },
  errorSerializer: new QuillaErrorSerializer(),
});

const logger = factory.create('OrderService');

try {
  await placeOrder(id);
} catch (err) {
  logger.error('Order placement failed', err);
  // pretty output:
  //   ConflictError [CONFLICT]: Order already exists
  //   context: {"orderId":"ord-99"}
  //     at OrderService.place (…)
}
```

Non-`QuillaError` values (plain `Error`, strings, etc.) return `undefined`
from `serialize()` so the logger falls back to its default serialization —
nothing breaks if both error types coexist in the same process.
