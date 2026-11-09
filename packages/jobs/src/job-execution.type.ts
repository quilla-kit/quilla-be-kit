import type { ExecutionContextView } from '@quilla-be-kit/execution-context';
import type { ScopeRunResult } from './scope-run.result.js';

export type JobExecution = {
  /** The current execution context, read live. Throws outside this run. */
  getContext(): ExecutionContextView;
  /**
   * Runs `fn` once per entry, sequentially, each in `withScope(scopeId)`. A
   * failing scope is logged and recorded without stopping the others; once
   * the run is aborted the remaining scopes are skipped.
   */
  forEachScope<T, R>(
    entries: Iterable<readonly [string, T]>,
    fn: (value: T, scopeId: string) => Promise<R>,
  ): Promise<ScopeRunResult<R>>;
};
