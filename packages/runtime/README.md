# @quilla-kit/runtime

Runtime composition primitives for a quilla-kit process: `IRegisteredModule`,
`ModuleRegistry`, and the wiring helpers that stitch modules into a running
service.

Deliberately does not depend on `@quilla-kit/http`, `@quilla-kit/persistence`,
or `@quilla-kit/messaging` — modules that use those capabilities register
*through* the runtime primitives, not the other way around. That keeps the runtime usable
in any shape of service (web, worker, job, CLI).

## Install

```sh
pnpm add @quilla-kit/runtime
```

## Status

Interface surface not yet implemented — scaffolded only.
