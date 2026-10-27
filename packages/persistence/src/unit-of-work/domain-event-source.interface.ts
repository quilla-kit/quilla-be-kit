/**
 * Something that collects domain events until the unit of work commits — a
 * DDD aggregate root satisfies it structurally.
 */
export interface DomainEventSource<TEvent = unknown> {
  drainDomainEvents(): readonly TEvent[];
}
