import { describe, expect, it } from 'vitest';
import { AsyncExecutionContextProvider } from '../src/async-execution-context.provider.js';
import { executionContextFactory } from '../src/execution-context.factory.js';
import type { ExecutionContext } from '../src/execution-context.type.js';

const baseCtx: ExecutionContext = {
  actorType: 'system',
  correlationId: 'corr-1',
  executionAttemptId: 'attempt-1',
};

describe('AsyncExecutionContextProvider', () => {
  it('throws when getContext() is called outside a runWithContext scope', () => {
    const provider = new AsyncExecutionContextProvider();
    expect(() => provider.getContext()).toThrow(/not available/);
  });

  it('returns the context during runWithContext', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      expect(provider.getContext()).toEqual(baseCtx);
    });
  });

  it('propagates context through nested async boundaries', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      expect(provider.getContext()).toEqual(baseCtx);
    });
  });

  it('isolates context across concurrent runs', async () => {
    const provider = new AsyncExecutionContextProvider();
    const a: ExecutionContext = {
      actorType: 'user',
      correlationId: 'a',
      executionAttemptId: 'attempt-a',
      session: { scopeId: 's-a', userId: 'user-a' },
    };
    const b: ExecutionContext = {
      actorType: 'user',
      correlationId: 'b',
      executionAttemptId: 'attempt-b',
      session: { scopeId: 's-b', userId: 'user-b' },
    };

    await Promise.all([
      provider.runWithContext(a, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        expect(provider.getContext().correlationId).toBe('a');
      }),
      provider.runWithContext(b, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        expect(provider.getContext().correlationId).toBe('b');
      }),
    ]);
  });

  it('throws again after runWithContext resolves', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {});
    expect(() => provider.getContext()).toThrow(/not available/);
  });

  it('defaults factory to the shared executionContextFactory', () => {
    const provider = new AsyncExecutionContextProvider();
    expect(provider.factory).toBe(executionContextFactory);
  });

  it('honors a consumer-supplied factory override', () => {
    const custom = {
      createSystemContext: () => ({
        actorType: 'system' as const,
        correlationId: 'custom',
        executionAttemptId: 'custom-attempt',
      }),
      createBaselineContext: () => ({
        actorType: 'anonymous' as const,
        correlationId: 'custom',
        executionAttemptId: 'custom-attempt',
      }),
      createFromEventMetadata: () => ({
        actorType: 'system' as const,
        correlationId: 'custom',
        executionAttemptId: 'custom-attempt',
      }),
    };
    const provider = new AsyncExecutionContextProvider({ factory: custom });
    expect(provider.factory).toBe(custom);
  });

  it('accepts a consumer-extended session shape structurally', async () => {
    type ExtendedSession = { scopeId: string; userId: string; role: string };
    type ExtendedCtx = ExecutionContext & { readonly session: ExtendedSession };
    const provider = new AsyncExecutionContextProvider();
    const ctx: ExtendedCtx = {
      ...baseCtx,
      session: { scopeId: 's1', userId: 'u1', role: 'admin' },
    };
    await provider.runWithContext(ctx, async () => {
      const read = provider.getContext() as ExtendedCtx;
      expect(read.session.role).toBe('admin');
    });
  });
});

describe('AsyncExecutionContextProvider.withScope', () => {
  const session = { scopeId: 's-1', userId: 'u-1' };

  it('enriches the current context with the scope, keeping its other fields', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      await provider.withScope('s-1', async () => {
        expect(provider.getContext()).toEqual({ ...baseCtx, scopeId: 's-1' });
      });
    });
  });

  it('restores the outer context after fn settles', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      await provider.withScope('s-1', async () => {});
      expect(provider.getContext()).toBe(baseCtx);
    });
  });

  it('returns what fn returns', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      await expect(provider.withScope('s-1', async () => 42)).resolves.toBe(42);
    });
  });

  it('joins a context already scoped to the same scopeId', async () => {
    const provider = new AsyncExecutionContextProvider();
    const scoped: ExecutionContext = { ...baseCtx, scopeId: 's-1' };
    await provider.runWithContext(scoped, async () => {
      await provider.withScope('s-1', async () => {
        expect(provider.getContext()).toBe(scoped);
      });
    });
  });

  it('joins a session with the same scope without adding a session-less scopeId', async () => {
    const provider = new AsyncExecutionContextProvider();
    const authenticated: ExecutionContext = { ...baseCtx, actorType: 'user', session };
    await provider.runWithContext(authenticated, async () => {
      await provider.withScope('s-1', async () => {
        expect(provider.getContext()).toBe(authenticated);
        expect(provider.getContext()).not.toHaveProperty('scopeId');
      });
    });
  });

  it.each<[string, ExecutionContext]>([
    ['session-less scope', { ...baseCtx, scopeId: 's-1' }],
    ['session scope', { ...baseCtx, actorType: 'user', session }],
  ])('rejects a different scope than the current %s', async (_label, ctx) => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(ctx, async () => {
      await expect(provider.withScope('s-2', async () => {})).rejects.toThrow(
        /already scoped to "s-1".*"s-2"/,
      );
    });
  });

  it('rejects outside a context', async () => {
    const provider = new AsyncExecutionContextProvider();
    await expect(provider.withScope('s-1', async () => {})).rejects.toThrow(/not available/);
  });

  it('rejects an empty scopeId', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      await expect(provider.withScope('', async () => {})).rejects.toThrow(/non-empty/);
    });
  });

  it('isolates concurrent scopes', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(baseCtx, async () => {
      const seen = await Promise.all(
        ['s-a', 's-b'].map((scopeId) =>
          provider.withScope(scopeId, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return provider.getContext().scopeId;
          }),
        ),
      );
      expect(seen).toEqual(['s-a', 's-b']);
    });
  });
});

describe('AsyncExecutionContextProvider.crossScope', () => {
  const platform: ExecutionContext = {
    actorType: 'user',
    correlationId: 'corr-1',
    executionAttemptId: 'attempt-1',
    session: { scopeId: 'platform', userId: 'admin-1' },
  };

  it('runs fn in the crossed context and restores the previous one afterwards', async () => {
    const provider = new AsyncExecutionContextProvider({ scopeCrossing: { authorize: () => {} } });
    await provider.runWithContext(platform, async () => {
      const seen = await provider.crossScope('tenant-1', async () => provider.getContext());
      expect(seen.session?.scopeId).toBe('tenant-1');
      expect(seen.crossedFrom).toBe('platform');
      expect(provider.getContext()).toBe(platform);
    });
  });

  it('joins without a new frame when the scope already matches', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(platform, async () => {
      const seen = await provider.crossScope('platform', async () => provider.getContext());
      expect(seen).toBe(platform);
    });
  });

  it('rejects crossing without a configured policy', async () => {
    const provider = new AsyncExecutionContextProvider();
    await provider.runWithContext(platform, async () => {
      await expect(provider.crossScope('tenant-1', async () => {})).rejects.toThrow(
        /no ScopeCrossingPolicy/,
      );
    });
  });

  it('resolves a thunk policy lazily, once', async () => {
    let built = 0;
    const provider = new AsyncExecutionContextProvider({
      scopeCrossing: () => {
        built += 1;
        return { authorize: () => {} };
      },
    });
    expect(built).toBe(0);
    await provider.runWithContext(platform, async () => {
      await provider.crossScope('tenant-1', async () => {});
      await provider.crossScope('tenant-2', async () => {});
    });
    expect(built).toBe(1);
  });

  it('rejects outside a context', async () => {
    const provider = new AsyncExecutionContextProvider();
    await expect(provider.crossScope('tenant-1', async () => {})).rejects.toThrow(/not available/);
  });
});
