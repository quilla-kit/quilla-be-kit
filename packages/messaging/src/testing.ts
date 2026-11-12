import { randomUUID } from 'node:crypto';
import type { ExecutionContextView } from '@quilla-be-kit/execution-context';
import { testContextView } from '@quilla-be-kit/execution-context/testing';
import { type HandlerEntryFields, createHandlerEntry } from './event-bus/handler-entry.factory.js';
import type { HandlerEntryWithContext } from './event-bus/handler-entry.type.js';

export { InMemoryHandlerOutcomeStore } from './event-bus/in-memory-handler-outcome.store.js';

export type TestHandlerEntryOptions<TView extends ExecutionContextView> = {
  /** What `getContext()` returns: a fixed view, or a function read on every call. */
  readonly context?: TView | (() => TView);
  readonly fields?: Partial<Omit<HandlerEntryFields, 'payload'>>;
};

/**
 * A `HandlerEntry` for handler tests. Defaults: random `id`, `eventType` `'test.event'`,
 * `eventVersion` 1, `occurredAt` now, and an unscoped `testContextView()`.
 */
export function createTestHandlerEntry<
  TPayload,
  TView extends ExecutionContextView = ExecutionContextView,
>(
  payload: TPayload,
  options: TestHandlerEntryOptions<TView> = {},
): HandlerEntryWithContext<TPayload, TView> {
  return createHandlerEntry(
    {
      id: randomUUID(),
      eventType: 'test.event',
      eventVersion: 1,
      occurredAt: new Date(),
      ...options.fields,
      payload,
    },
    options.context ?? (testContextView() as TView),
  );
}
