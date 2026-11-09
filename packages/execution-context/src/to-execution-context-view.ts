import type { ExecutionContextView } from './execution-context-view.type.js';
import type { ExecutionContext } from './execution-context.type.js';
import { effectiveCrossedFrom, resolveScopeId } from './resolve-scope-id.js';

export function toExecutionContextView(ctx: ExecutionContext): ExecutionContextView {
  const scopeId = resolveScopeId(ctx);
  const crossedFrom = effectiveCrossedFrom(scopeId, ctx.crossedFrom);
  return Object.freeze({
    actorType: ctx.actorType,
    correlationId: ctx.correlationId,
    executionAttemptId: ctx.executionAttemptId,
    ...(scopeId !== undefined ? { scopeId } : {}),
    ...(ctx.session ? { userId: ctx.session.userId, session: ctx.session } : {}),
    ...(crossedFrom !== undefined ? { crossedFrom } : {}),
  });
}
