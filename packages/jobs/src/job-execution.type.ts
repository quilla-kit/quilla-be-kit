import type { ExecutionContextView } from '@quilla-be-kit/execution-context';
import type { ScopeRunResult } from './scope-run.result.js';

export type ForEachScopeOptions<T> = {
  /**
   * Replaces the default failure log. Runs in the job's own context, not the
   * failing scope's; `aborted` is true for an error thrown after the run was
   * aborted (still recorded as skipped). A throw or rejection is logged.
   */
  readonly onScopeFailed?: (
    error: unknown,
    scopeId: string,
    value: T,
    info: { readonly aborted: boolean },
  ) => void | Promise<void>;
};

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
    options?: ForEachScopeOptions<T>,
  ): Promise<ScopeRunResult<R>>;
};
