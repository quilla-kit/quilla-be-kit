import type { DomainEvent } from './domain-event.js';
import type { EventMetadata } from './event-metadata.js';
import type { IntegrationEvent } from './integration-event.js';

export type AnyEvent = DomainEvent | IntegrationEvent;

export class EnvelopedEvent<TEvent extends AnyEvent = AnyEvent> {
  constructor(
    readonly event: TEvent,
    readonly metadata: EventMetadata,
  ) {}
}
