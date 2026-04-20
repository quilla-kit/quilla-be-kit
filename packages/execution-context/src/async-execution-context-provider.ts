import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExecutionContextProvider } from './execution-context-provider.js';
import type { ExecutionContext } from './execution-context.js';

/**
 * Node-native `ExecutionContextProvider` backed by an `AsyncLocalStorage`
 * instance owned by this class. Intended as one instance per process, wired
 * in at the composition root.
 */
export class AsyncExecutionContextProvider implements ExecutionContextProvider {
  private readonly storage = new AsyncLocalStorage<ExecutionContext>();

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
}
