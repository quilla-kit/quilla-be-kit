import type { ActorType } from '@quilla-be-kit/ddd';
import type { AuthSession } from './auth-session.type.js';

/**
 * Read-only props of an execution context, with the scope already resolved
 * from the session or the session-less `scopeId`.
 */
export type ExecutionContextView = {
  readonly actorType: ActorType;
  readonly correlationId: string;
  readonly executionAttemptId: string;
  readonly scopeId?: string;
  readonly userId?: string;
  readonly session?: AuthSession;
  readonly crossedFrom?: string;
};

export type ScopedExecutionContextView = ExecutionContextView & { readonly scopeId: string };

export type SessionExecutionContextView = ScopedExecutionContextView & {
  readonly userId: string;
  readonly session: AuthSession;
};
