import type { DomainEvent } from '../events/domain-event.js';
import { Entity } from './entity.js';

export abstract class AggregateRoot<TProps extends object = object> extends Entity<TProps> {
  private domainEvents: DomainEvent[] = [];

  protected addDomainEvent(event: DomainEvent): void {
    this.domainEvents.push(event);
  }

  /**
   * Returns all accumulated domain events and clears them. The Unit of Work
   * calls this before commit to flush events into the outbox.
   *
   * Aggregates composed of child aggregates should override this method and
   * concatenate the children's drained events with `super.drainDomainEvents()`.
   */
  drainDomainEvents(): DomainEvent[] {
    const events = [...this.domainEvents];
    this.domainEvents = [];
    return events;
  }
}
