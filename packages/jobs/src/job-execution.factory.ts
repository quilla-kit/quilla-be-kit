import {
  type ExecutionContext,
  type ExecutionContextProvider,
  readAttemptContext,
  resolveScopeId,
  toExecutionContextView,
} from '@quilla-be-kit/execution-context';
import type { Logger } from '@quilla-be-kit/observability';
import type { JobExecution } from './job-execution.type.js';
import type { ScopeRunResult } from './scope-run.result.js';

export type JobExecutionOptions = {
  readonly provider: ExecutionContextProvider;
  /** The context the runner established for this run. */
  readonly context: ExecutionContext;
  readonly logger: Logger;
  readonly signal: AbortSignal;
};

/** Builds the `JobExecution` a runner passes to `BackgroundJob.execute`. */
export function createJobExecution(options: JobExecutionOptions): JobExecution {
  const { provider, context, logger, signal } = options;

  const current = (): ExecutionContext => {
    const ctx = readAttemptContext(provider, context.executionAttemptId);
    if (!ctx) {
      throw new Error('JobExecution was used outside its run; use it while the job executes');
    }
    return ctx;
  };

  return {
    getContext: () => toExecutionContextView(current()),

    async forEachScope<T, R>(
      entries: Iterable<readonly [string, T]>,
      fn: (value: T, scopeId: string) => Promise<R>,
    ): Promise<ScopeRunResult<R>> {
      const outer = resolveScopeId(current());
      if (outer !== undefined) {
        throw new Error(
          `forEachScope: the context is already scoped to "${outer}"; call it from the job's own context`,
        );
      }
      const succeeded: { scopeId: string; value: R }[] = [];
      const failed: { scopeId: string; error: unknown }[] = [];
      const skipped: string[] = [];
      for (const [scopeId, value] of entries) {
        if (signal.aborted) {
          skipped.push(scopeId);
          continue;
        }
        try {
          succeeded.push({
            scopeId,
            value: await provider.withScope(scopeId, () => fn(value, scopeId)),
          });
        } catch (error) {
          if (signal.aborted) {
            skipped.push(scopeId);
            continue;
          }
          logger.error('Scope failed; continuing with the next one', error, { meta: { scopeId } });
          failed.push({ scopeId, error });
        }
      }
      return { succeeded, failed, skipped };
    },
  };
}
