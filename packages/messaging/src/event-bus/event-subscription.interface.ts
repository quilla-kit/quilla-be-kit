import type { ContextRequirement } from '@quilla-be-kit/execution-context';
import type { EventDescriptor } from './event.descriptor.js';
import type {
  HandlerEntry,
  ScopedHandlerEntry,
  SessionHandlerEntry,
} from './handler-entry.type.js';

export interface EventSubscription<TPayload = unknown> {
  readonly descriptor: EventDescriptor<TPayload>;
  /** Checked before this handler runs; an unmet requirement fails it as a permanent failure. */
  readonly requires?: ContextRequirement | undefined;
  /**
   * Persistent identity of this handler among the event's handlers, used by `handlerOutcomes`.
   * Required, unique per event type, when an event type has several handlers and outcomes are on.
   */
  readonly key?: string | undefined;
  // Method syntax: bivariant in TPayload (heterogeneous arrays type-check) and
  // lets classes `implements` this with a plain `async handle(entry)` method.
  handle(entry: HandlerEntry<TPayload>): Promise<void>;
}

export interface ScopedEventSubscription<TPayload = unknown> extends EventSubscription<TPayload> {
  readonly requires: 'scope' | 'session';
  handle(entry: ScopedHandlerEntry<TPayload>): Promise<void>;
}

export interface SessionEventSubscription<TPayload = unknown>
  extends ScopedEventSubscription<TPayload> {
  readonly requires: 'session';
  handle(entry: SessionHandlerEntry<TPayload>): Promise<void>;
}
