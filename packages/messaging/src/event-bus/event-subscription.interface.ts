import type { EventDescriptor } from './event.descriptor.js';
import type { HandlerEntry } from './handler-entry.type.js';

export interface EventSubscription<TPayload = unknown> {
  readonly descriptor: EventDescriptor<TPayload>;
  // Method syntax: bivariant in TPayload (heterogeneous arrays type-check) and
  // lets classes `implements` this with a plain `async handle(entry)` method.
  handle(entry: HandlerEntry<TPayload>): Promise<void>;
}
