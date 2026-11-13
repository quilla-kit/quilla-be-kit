import type { ContextRequirement } from '@quilla-be-kit/execution-context';
import type { EventDescriptor } from './event.descriptor.js';
import type {
  HandlerEntry,
  ScopedHandlerEntry,
  SessionHandlerEntry,
} from './handler-entry.type.js';
import type { RetryPolicy } from './retry.policy.js';

export interface EventSubscription<TPayload = unknown> {
  readonly descriptor: EventDescriptor<TPayload>;
  /** Checked before this handler runs; an unmet requirement fails it as a permanent failure. */
  readonly requires?: ContextRequirement | undefined;
  /**
   * Persistent identity of this handler. Under `isolation` it names the subscriber (required;
   * the same key on several event types is one subscriber). With `handlerOutcomes` it is
   * required, unique per event type, when an event type has several handlers.
   */
  readonly key?: string | undefined;
  /** Under `isolation`: how this subscriber's failed work is retried. */
  readonly retry?: RetryPolicy | undefined;
  /** Under `isolation`: earlier keys of this subscriber, whose queued work moves to `key`. */
  readonly previousKeys?: readonly string[] | undefined;
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
