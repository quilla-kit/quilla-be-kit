import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ExecutionContextFactory,
  executionContextFactory,
} from './execution-context.factory.js';
import type { ExecutionContextProvider } from './execution-context.provider.js';
import type { ExecutionContext } from './execution-context.type.js';
import { resolveScopeId } from './resolve-scope-id.js';

export type AsyncExecutionContextProviderOptions = {
  readonly factory?: ExecutionContextFactory;
};

/**
 * Node-native `ExecutionContextProvider` backed by an `AsyncLocalStorage`
 * instance owned by this class. Intended as one instance per process, wired
 * in at the composition root.
 */
export class AsyncExecutionContextProvider implements ExecutionContextProvider {
  private readonly storage = new AsyncLocalStorage<ExecutionContext>();
  readonly factory: ExecutionContextFactory;

  constructor(options?: AsyncExecutionContextProviderOptions) {
    this.factory = options?.factory ?? executionContextFactory;
  }

  getContext(): ExecutionContext {
    const ctx = this.storage.getStore();
    if (ctx === undefined) {
      throw new Error(
        'ExecutionContext not available: wrap the call in provider.runWithContext(ctx, fn) to establish one',
      );
    }
    return ctx;
  }

  runWithContext<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(ctx, fn);
  }

  async withScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    if (typeof scopeId !== 'string' || scopeId === '') {
      throw new Error('withScope: scopeId must be a non-empty string');
    }
    const ctx = this.getContext();
    const current = resolveScopeId(ctx);
    if (current === scopeId) return fn();
    if (current !== undefined) {
      throw new Error(
        `withScope: context is already scoped to "${current}", cannot run in scope "${scopeId}"`,
      );
    }
    return this.storage.run({ ...ctx, scopeId }, fn);
  }
}
