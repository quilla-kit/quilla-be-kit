# @quilla-kit/security

Security primitives — the building blocks consumers compose into their own auth
module.

**What it ships:**

- JWT issuance and verification
- Password hashing (argon2 / bcrypt)
- Authorization decorators and policy hooks that plug into `@quilla-kit/http`'s
  `@Authorize`
- Identity materialization — resolving a verified token into an
  `IExecutionContext` via `@quilla-kit/execution-context`

**What it does not ship:** a complete, opinionated user registration / login
flow. Those are product-shaped concerns that belong in a consumer module. This
package gives you the pieces; you assemble them.

## Role in quilla-kit

`@quilla-kit/security` doubles as the toolkit's **rule-of-three validation
harness** — the first real consumer that exercises every other package:

- `@quilla-kit/ddd` — identity value objects, security-related domain and
  integration events
- `@quilla-kit/persistence` — persisting credentials and sessions through the
  repository + outbox pattern
- `@quilla-kit/messaging` — dispatching integration events (e.g.
  `UserAuthenticated`, `TokenRevoked`) to downstream consumers
- `@quilla-kit/http` — `@Authorize`, `@ValidateRequest`
- `@quilla-kit/execution-context` — identity materialization
- `@quilla-kit/observability` — structured logs across the auth path
- `@quilla-kit/runtime` — registration as a module

If these primitives can be composed into a clean auth module inside a consumer
project, the substrate is right. The moment that composition starts bending
quilla-kit's interfaces, we catch it here.

## Install

```sh
pnpm add @quilla-kit/security
```

## Status

Interface surface not yet implemented — scaffolded only.
