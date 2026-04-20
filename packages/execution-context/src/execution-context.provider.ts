import type { ExecutionContext } from './execution-context.js';

export interface ExecutionContextProvider {
  /**
   * Returns the current execution context. Throws if called outside a
   * `runWithContext(...)` scope — callers are expected to establish a
   * context before invoking downstream code that reads it.
   */
  getContext(): ExecutionContext;

  /** Runs `fn` with `ctx` as the active execution context. */
  runWithContext<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T>;
}
