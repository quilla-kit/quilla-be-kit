import type { ExecutionContextFactory } from './execution-context.factory.js';
import type { ExecutionContext } from './execution-context.type.js';

export interface ExecutionContextProvider {
  /**
   * The factory paired with this provider. Callers that need to mint
   * baseline/system/event-sourced contexts read it from here rather than
   * taking a separate `factory` parameter.
   */
  readonly factory: ExecutionContextFactory;

  /**
   * Returns the current execution context. Throws if called outside a
   * `runWithContext(...)` scope — callers are expected to establish a
   * context before invoking downstream code that reads it.
   */
  getContext(): ExecutionContext;

  /** Runs `fn` with `ctx` as the active execution context. */
  runWithContext<T>(ctx: ExecutionContext, fn: () => Promise<T>): Promise<T>;
}
