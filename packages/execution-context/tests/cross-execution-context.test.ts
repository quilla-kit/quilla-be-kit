import { describe, expect, it, vi } from 'vitest';
import { crossExecutionContext } from '../src/cross-execution-context.js';
import type { ExecutionContext } from '../src/execution-context.type.js';
import type { ScopeCrossingPolicy } from '../src/scope-crossing.policy.js';

const allowAll: ScopeCrossingPolicy = { authorize: () => {} };

const platformUser = {
  actorType: 'user',
  correlationId: 'corr-1',
  executionAttemptId: 'attempt-1',
  session: { scopeId: 'platform', userId: 'admin-1', projectId: 'p-1' },
  featureTier: 'gold',
} as ExecutionContext;

const scopedJob: ExecutionContext = {
  actorType: 'job',
  correlationId: 'corr-2',
  executionAttemptId: 'attempt-2',
  scopeId: 'scope-a',
};

describe('crossExecutionContext', () => {
  it('adds a scope to an unscoped context without consulting the policy', async () => {
    const authorize = vi.fn();
    const ctx: ExecutionContext = { actorType: 'job', correlationId: 'c', executionAttemptId: 'a' };
    const next = await crossExecutionContext(ctx, 'scope-a', { authorize });
    expect(next).toEqual({ ...ctx, scopeId: 'scope-a' });
    expect(authorize).not.toHaveBeenCalled();
  });

  it('joins the current context when the scope already matches', async () => {
    const next = await crossExecutionContext(platformUser, 'platform', undefined);
    expect(next).toBe(platformUser);
  });

  it('rejects crossing when no policy is configured', async () => {
    await expect(crossExecutionContext(platformUser, 'tenant-1', undefined)).rejects.toThrow(
      /no ScopeCrossingPolicy is configured/,
    );
  });

  it('rejects an empty target scope', async () => {
    await expect(crossExecutionContext(platformUser, '', allowAll)).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("propagates the policy's own denial error", async () => {
    class Denied extends Error {}
    const policy: ScopeCrossingPolicy = {
      authorize: async () => {
        throw new Denied('nope');
      },
    };
    await expect(crossExecutionContext(platformUser, 'tenant-1', policy)).rejects.toBeInstanceOf(
      Denied,
    );
  });

  it('passes the source context and target to authorize', async () => {
    const authorize = vi.fn();
    await crossExecutionContext(platformUser, 'tenant-1', { authorize });
    expect(authorize).toHaveBeenCalledWith(platformUser, 'tenant-1');
  });

  it('keeps only the allowlisted fields by default and records crossedFrom', async () => {
    const next = await crossExecutionContext(platformUser, 'tenant-1', allowAll);
    expect(next).toEqual({
      actorType: 'user',
      correlationId: 'corr-1',
      executionAttemptId: 'attempt-1',
      session: { scopeId: 'tenant-1', userId: 'admin-1' },
      crossedFrom: 'platform',
    });
  });

  it('crosses a session-less context', async () => {
    const next = await crossExecutionContext(scopedJob, 'scope-b', allowAll);
    expect(next).toEqual({
      actorType: 'job',
      correlationId: 'corr-2',
      executionAttemptId: 'attempt-2',
      scopeId: 'scope-b',
      crossedFrom: 'scope-a',
    });
  });

  it('lets a custom projection keep extended fields', async () => {
    const policy: ScopeCrossingPolicy = {
      authorize: () => {},
      projectContext: (ctx, target) =>
        ({
          ...ctx,
          session: { ...(ctx.session as object), scopeId: target },
        }) as ExecutionContext,
    };
    const next = await crossExecutionContext(platformUser, 'tenant-1', policy);
    expect(next).toMatchObject({
      session: { scopeId: 'tenant-1', userId: 'admin-1', projectId: 'p-1' },
      featureTier: 'gold',
      crossedFrom: 'platform',
    });
  });

  it('ignores a crossedFrom set by the projection', async () => {
    const policy: ScopeCrossingPolicy = {
      authorize: () => {},
      projectContext: (ctx, target) => ({
        actorType: ctx.actorType,
        correlationId: ctx.correlationId,
        executionAttemptId: ctx.executionAttemptId,
        scopeId: target,
        crossedFrom: 'forged',
      }),
    };
    const next = await crossExecutionContext(scopedJob, 'scope-b', policy);
    expect(next.crossedFrom).toBe('scope-a');
  });

  it('keeps the outermost origin across nested crossings', async () => {
    const first = await crossExecutionContext(platformUser, 'tenant-1', allowAll);
    const second = await crossExecutionContext(first, 'tenant-2', allowAll);
    expect(second.crossedFrom).toBe('platform');
  });

  it('clears crossedFrom when crossing back to the origin', async () => {
    const there = await crossExecutionContext(platformUser, 'tenant-1', allowAll);
    const back = await crossExecutionContext(there, 'platform', allowAll);
    expect(back.crossedFrom).toBeUndefined();
    expect(back.session?.scopeId).toBe('platform');
  });

  const invalid: ReadonlyArray<[string, (ctx: ExecutionContext, t: string) => ExecutionContext]> = [
    [
      'actorType',
      (ctx, t) => ({ ...ctx, actorType: 'system', session: { scopeId: t, userId: 'admin-1' } }),
    ],
    [
      'correlationId',
      (ctx, t) => ({ ...ctx, correlationId: 'x', session: { scopeId: t, userId: 'admin-1' } }),
    ],
    [
      'executionAttemptId',
      (ctx, t) => ({ ...ctx, executionAttemptId: 'x', session: { scopeId: t, userId: 'admin-1' } }),
    ],
    [
      'the session',
      (ctx, t) => ({
        actorType: ctx.actorType,
        correlationId: ctx.correlationId,
        executionAttemptId: ctx.executionAttemptId,
        scopeId: t,
      }),
    ],
    [
      "the session's userId",
      (ctx, t) => ({ ...ctx, session: { scopeId: t, userId: 'someone-else' } }),
    ],
    [
      'a session-less scopeId beside a session',
      (ctx, t) => ({ ...ctx, scopeId: t, session: { scopeId: t, userId: 'admin-1' } }),
    ],
    [
      'the context to "tenant-1"',
      (ctx) => ({ ...ctx, session: { scopeId: 'elsewhere', userId: 'admin-1' } }),
    ],
  ];

  it.each(invalid)('rejects a projection that breaks %s', async (reason, projectContext) => {
    const policy: ScopeCrossingPolicy = { authorize: () => {}, projectContext };
    await expect(crossExecutionContext(platformUser, 'tenant-1', policy)).rejects.toThrow(
      new RegExp(`projectContext must.*${reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('rejects a projection that adds a session to a session-less context', async () => {
    const policy: ScopeCrossingPolicy = {
      authorize: () => {},
      projectContext: (ctx, t) => ({
        actorType: ctx.actorType,
        correlationId: ctx.correlationId,
        executionAttemptId: ctx.executionAttemptId,
        session: { scopeId: t, userId: 'u' },
      }),
    };
    await expect(crossExecutionContext(scopedJob, 'scope-b', policy)).rejects.toThrow(
      /must not add a session/,
    );
  });
});
