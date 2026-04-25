import { describe, expect, it } from 'vitest';
import { AsyncExecutionContextProvider } from '../src/async-execution-context.provider.js';
import { executionContextFactory } from '../src/execution-context.factory.js';
import type { ExecutionContext } from '../src/execution-context.type.js';

const baseCtx: ExecutionContext = {
  actorType: 'system',
  correlationId: 'corr-1',
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
      session: { scopeId: 's-a', userId: 'user-a' },
    };
    const b: ExecutionContext = {
      actorType: 'user',
      correlationId: 'b',
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
      createSystemContext: () => ({ actorType: 'system' as const, correlationId: 'custom' }),
      createBaselineContext: () => ({ actorType: 'anonymous' as const, correlationId: 'custom' }),
      createFromEventMetadata: () => ({ actorType: 'system' as const, correlationId: 'custom' }),
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
