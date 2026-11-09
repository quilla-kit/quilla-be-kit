import type { ExecutionContextView } from '@quilla-be-kit/execution-context';
import type { HandlerEntry, HandlerEntryWithContext } from './handler-entry.type.js';

export type HandlerEntryFields<TPayload = unknown> = Omit<HandlerEntry<TPayload>, 'getContext'>;

/**
 * Builds a `HandlerEntry`. `context` is a fixed view (tests) or a function
 * called on every `getContext()`.
 */
export function createHandlerEntry<TPayload, TView extends ExecutionContextView>(
  fields: HandlerEntryFields<TPayload>,
  context: TView | (() => TView),
): HandlerEntryWithContext<TPayload, TView> {
  const read = typeof context === 'function' ? context : () => context;
  return { ...fields, getContext: read };
}
