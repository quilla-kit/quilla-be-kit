# @quilla-kit/ddd

Domain-Driven Design tactical primitives — the shared vocabulary that every
other `@quilla-kit/*` package uses to talk about domain objects and the events
and actors they produce.

## What it ships

- **Identity types** — `AggregateRoot`, `Entity` (DDD tactical base classes)
- **Event types** — `DomainEvent`, `IntegrationEvent`, `EventMetadata`
- **Actor vocabulary** — `ActorType` (e.g. user / system / service) — identity
  of the caller, used by `@quilla-kit/execution-context` to enrich audit trails
  and event metadata

Zero runtime dependencies. Sits at the bottom of the toolkit's dependency
graph; imported by `execution-context`, `persistence`, `messaging`, and
`security`.

## Why one package

`AggregateRoot` raises `DomainEvent`s. `EventMetadata` carries an `ActorType`.
These types are a tight, co-evolving cluster — splitting them produces either
circular dependencies or duplication. One package keeps the cluster coherent.

## Install

```sh
pnpm add @quilla-kit/ddd
```

## Status

Interface surface not yet implemented — scaffolded only.
