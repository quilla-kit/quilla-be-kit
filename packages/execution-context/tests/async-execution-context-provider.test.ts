import { describe, expect, it } from 'vitest';
import { AsyncExecutionContextProvider } from '../src/async-execution-context-provider.js';
import type { ExecutionContext } from '../src/execution-context.js';

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
    const a: ExecutionContext = { actorType: 'user', correlationId: 'a', userId: 'user-a' };
    const b: ExecutionContext = { actorType: 'user', correlationId: 'b', userId: 'user-b' };

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

  it('accepts a consumer-extended context shape structurally', async () => {
    type ExtendedCtx = ExecutionContext & { readonly session: { readonly role: string } };
    const provider = new AsyncExecutionContextProvider();
    const ctx: ExtendedCtx = { ...baseCtx, session: { role: 'admin' } };
    await provider.runWithContext(ctx, async () => {
      const read = provider.getContext() as ExtendedCtx;
      expect(read.session.role).toBe('admin');
    });
  });
});
