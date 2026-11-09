import type { ExecutionContext } from './execution-context.type.js';

/**
 * App-owned rules for `crossScope` between two scopes. Configured on the
 * provider; without one, crossing scopes is rejected.
 */
export interface ScopeCrossingPolicy {
  /** Runs in the source context. Throw (with the app's own error) to deny. */
  authorize(context: ExecutionContext, targetScopeId: string): void | Promise<void>;

  /**
   * Builds the context to run in the target scope. Defaults to `actorType`,
   * `correlationId`, `executionAttemptId` and the target scope (keeping the
   * session's `userId`); every other field is dropped.
   */
  projectContext?(
    context: ExecutionContext,
    targetScopeId: string,
  ): ExecutionContext | Promise<ExecutionContext>;
}
