import type { ExecutionContext } from './execution-context.type.js';
import { resolveScopeId } from './resolve-scope-id.js';
import type { ScopeCrossingPolicy } from './scope-crossing.policy.js';

/**
 * Builds the context `crossScope(targetScopeId, fn)` runs `fn` in. Exported so
 * custom providers enforce the same invariants as `AsyncExecutionContextProvider`.
 */
export async function crossExecutionContext(
  current: ExecutionContext,
  targetScopeId: string,
  policy: ScopeCrossingPolicy | undefined,
): Promise<ExecutionContext> {
  const added = addOrJoinScope(current, targetScopeId, 'crossScope');
  if (added) return added;
  const currentScope = resolveScopeId(current) as string;
  if (!policy) {
    throw new Error(
      `crossScope: context is scoped to "${currentScope}" and no ScopeCrossingPolicy is configured; pass \`scopeCrossing\` to the provider to allow crossing to "${targetScopeId}"`,
    );
  }

  await policy.authorize(current, targetScopeId);
  const projected = policy.projectContext
    ? await policy.projectContext(current, targetScopeId)
    : defaultProjection(current, targetScopeId);
  assertProjection(current, projected, targetScopeId);

  // The kit owns provenance: a projection cannot set or clear it.
  const { crossedFrom: _discarded, ...rest } = projected;
  const origin = current.crossedFrom ?? currentScope;
  return origin === targetScopeId ? rest : { ...rest, crossedFrom: origin };
}

/**
 * The rule `withScope` and `crossScope` share: add a scope to an unscoped
 * context, join the same scope. `undefined` when the context has another scope.
 */
export function addOrJoinScope(
  current: ExecutionContext,
  targetScopeId: string,
  caller: string,
): ExecutionContext | undefined {
  if (typeof targetScopeId !== 'string' || targetScopeId === '') {
    throw new Error(`${caller}: scopeId must be a non-empty string`);
  }
  const currentScope = resolveScopeId(current);
  if (currentScope === undefined) return { ...current, scopeId: targetScopeId };
  return currentScope === targetScopeId ? current : undefined;
}

function defaultProjection(current: ExecutionContext, targetScopeId: string): ExecutionContext {
  const base = {
    actorType: current.actorType,
    correlationId: current.correlationId,
    executionAttemptId: current.executionAttemptId,
  };
  return current.session
    ? { ...base, session: { scopeId: targetScopeId, userId: current.session.userId } }
    : { ...base, scopeId: targetScopeId };
}

function assertProjection(
  current: ExecutionContext,
  projected: ExecutionContext,
  targetScopeId: string,
): void {
  const fail = (reason: string) => new Error(`crossScope: projectContext ${reason}`);
  for (const key of ['actorType', 'correlationId', 'executionAttemptId'] as const) {
    if (projected[key] !== current[key]) throw fail(`must keep ${key}`);
  }
  if (Boolean(projected.session) !== Boolean(current.session)) {
    throw fail(current.session ? 'must keep the session' : 'must not add a session');
  }
  if (current.session && projected.session?.userId !== current.session.userId) {
    throw fail("must keep the session's userId");
  }
  if (projected.session && projected.scopeId !== undefined) {
    throw fail('must not set a session-less scopeId beside a session');
  }
  if (resolveScopeId(projected) !== targetScopeId) {
    throw fail(`must scope the context to "${targetScopeId}"`);
  }
}
