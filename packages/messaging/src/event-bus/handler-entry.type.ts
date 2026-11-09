import type {
  ExecutionContextView,
  ScopedExecutionContextView,
  SessionExecutionContextView,
} from '@quilla-be-kit/execution-context';

export type HandlerEntry<TPayload = unknown> = {
  readonly id: string;
  readonly payload: TPayload;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
  /**
   * The current execution context, read live on every call. Throws when the
   * consumer has no `executionContext` wired, when called outside this
   * handler's dispatch, or when the context no longer meets `requires`.
   */
  getContext(): ExecutionContextView;
};

export type HandlerEntryWithContext<TPayload, TView extends ExecutionContextView> = Omit<
  HandlerEntry<TPayload>,
  'getContext'
> & {
  getContext(): TView;
};

export type ScopedHandlerEntry<TPayload = unknown> = HandlerEntryWithContext<
  TPayload,
  ScopedExecutionContextView
>;

export type SessionHandlerEntry<TPayload = unknown> = HandlerEntryWithContext<
  TPayload,
  SessionExecutionContextView
>;
