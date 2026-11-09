import { AsyncLocalStorage } from 'node:async_hooks';
import { addOrJoinScope, crossExecutionContext } from './cross-execution-context.js';
import {
  type ExecutionContextFactory,
  executionContextFactory,
} from './execution-context.factory.js';
import type { ExecutionContextProvider } from './execution-context.provider.js';
import type { ExecutionContext } from './execution-context.type.js';
import { resolveScopeId } from './resolve-scope-id.js';
import type { ScopeCrossingPolicy } from './scope-crossing.policy.js';

export type AsyncExecutionContextProviderOptions = {
  readonly factory?: ExecutionContextFactory;
  /** Required to cross between scopes. A thunk is resolved on first use. */
  readonly scopeCrossing?: ScopeCrossingPolicy | (() => ScopeCrossingPolicy);
};

/**
 * Node-native `ExecutionContextProvider` backed by an `AsyncLocalStorage`
 * instance owned by this class. Intended as one instance per process, wired
 * in at the composition root.
 */
export class AsyncExecutionContextProvider implements ExecutionContextProvider {
  private readonly storage = new AsyncLocalStorage<ExecutionContext>();
  readonly factory: ExecutionContextFactory;
  private scopeCrossing: AsyncExecutionContextProviderOptions['scopeCrossing'];

  constructor(options?: AsyncExecutionContextProviderOptions) {
    this.factory = options?.factory ?? executionContextFactory;
    this.scopeCrossing = options?.scopeCrossing;
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
    const ctx = this.getContext();
    const next = addOrJoinScope(ctx, scopeId, 'withScope');
    if (!next) {
      throw new Error(
        `withScope: context is already scoped to "${resolveScopeId(ctx)}", cannot run in scope "${scopeId}"`,
      );
    }
    return next === ctx ? fn() : this.storage.run(next, fn);
  }

  async crossScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.getContext();
    const next = await crossExecutionContext(current, scopeId, this.resolvePolicy());
    return next === current ? fn() : this.storage.run(next, fn);
  }

  private resolvePolicy(): ScopeCrossingPolicy | undefined {
    if (typeof this.scopeCrossing === 'function') this.scopeCrossing = this.scopeCrossing();
    return this.scopeCrossing;
  }
}
