import type { AuthSession } from './auth-session.type.js';
import type { ContextRequirement } from './context-requirement.type.js';
import type { ExecutionContext } from './execution-context.type.js';
import { MissingScopeError } from './missing-scope.error.js';
import { MissingSessionError } from './missing-session.error.js';
import { resolveScopeId } from './resolve-scope-id.js';

/**
 * The operation's scope, for work that is scoped by contract. Throws
 * `MissingScopeError` when there is none; a context carrying both scopes
 * still throws `resolveScopeId`'s plain `Error`.
 */
export function requireScopeId(ctx: ExecutionContext): string {
  const scopeId = resolveScopeId(ctx);
  if (scopeId === undefined) {
    throw new MissingScopeError({ actorType: ctx.actorType, correlationId: ctx.correlationId });
  }
  return scopeId;
}

/** Throws `MissingScopeError` / `MissingSessionError` when `ctx` does not meet `requirement`. */
export function requireContext(ctx: ExecutionContext, requirement: ContextRequirement): void {
  if (requirement === 'session') requireSession(ctx);
  else requireScopeId(ctx);
}

/** The authenticated session. Throws `MissingSessionError` when there is none. */
export function requireSession(ctx: ExecutionContext): AuthSession {
  if (!ctx.session) {
    throw new MissingSessionError({ actorType: ctx.actorType, correlationId: ctx.correlationId });
  }
  return ctx.session;
}
