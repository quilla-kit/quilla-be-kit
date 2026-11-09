import type { ExecutionContextProvider } from './execution-context.provider.js';
import type { ExecutionContext } from './execution-context.type.js';

/**
 * The current context while it still belongs to the attempt `attemptId`
 * (`withScope` and `crossScope` keep the attempt id), otherwise `undefined`.
 * Lets a handle given to a handler or job detect it escaped its run.
 */
export function readAttemptContext(
  provider: ExecutionContextProvider,
  attemptId: string,
): ExecutionContext | undefined {
  try {
    const ctx = provider.getContext();
    return ctx.executionAttemptId === attemptId ? ctx : undefined;
  } catch {
    return undefined;
  }
}
