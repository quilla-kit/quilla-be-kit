import type { AggregateRoot, AnyEvent } from '@quilla-be-kit/ddd';
import type { UnitOfWorkContext as EventUnitOfWorkContext } from '../unit-of-work/unit-of-work-context.type.js';
import {
  UnitOfWork as EventUnitOfWork,
  type UnitOfWorkOptions as EventUnitOfWorkOptions,
} from '../unit-of-work/unit-of-work.js';

export type UnitOfWorkOptions<TEntry = unknown> = EventUnitOfWorkOptions<TEntry, AnyEvent>;

export type UnitOfWorkContext = EventUnitOfWorkContext<AnyEvent> & {
  registerAggregate(...aggregates: readonly AggregateRoot<object>[]): void;
};

/**
 * `UnitOfWork` bound to the DDD event types — aggregates' domain events plus
 * integration events — whose context adds `registerAggregate`.
 */
export class UnitOfWork<TEntry = unknown> extends EventUnitOfWork<
  TEntry,
  AnyEvent,
  UnitOfWorkContext
> {
  protected override extendContext(ctx: EventUnitOfWorkContext<AnyEvent>): UnitOfWorkContext {
    return { ...ctx, registerAggregate: ctx.registerEventSource };
  }
}
