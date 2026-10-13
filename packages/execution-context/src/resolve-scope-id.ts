import type { ExecutionContext } from './execution-context.type.js';

/**
 * The operation's scope: the session's when authenticated, otherwise the
 * session-less `scopeId`. Throws when both are set, so the session is never
 * silently preferred over a conflicting scope.
 */
export function resolveScopeId(ctx: ExecutionContext): string | undefined {
  if (ctx.session && ctx.scopeId !== undefined) {
    throw new Error(
      `ExecutionContext carries both session scope "${ctx.session.scopeId}" and scopeId "${ctx.scopeId}": a session-less scopeId must not sit beside a session`,
    );
  }
  return ctx.session?.scopeId ?? ctx.scopeId;
}
