import {
  AsyncExecutionContextProvider,
  type ExecutionContext,
} from '@quilla-be-kit/execution-context';
import type { Logger } from '@quilla-be-kit/observability';
import { describe, expect, it, vi } from 'vitest';
import { createJobExecution } from '../src/job-execution.factory.js';

const jobCtx: ExecutionContext = {
  actorType: 'job',
  correlationId: 'corr-1',
  executionAttemptId: 'attempt-1',
};

function makeLogger() {
  const error = vi.fn();
  const logger = { error } as unknown as Logger;
  return { logger, error };
}

async function inRun<T>(
  fn: (execution: ReturnType<typeof createJobExecution>, controller: AbortController) => Promise<T>,
  provider = new AsyncExecutionContextProvider(),
  logger = makeLogger().logger,
): Promise<T> {
  const controller = new AbortController();
  return provider.runWithContext(jobCtx, () =>
    fn(
      createJobExecution({ provider, context: jobCtx, logger, signal: controller.signal }),
      controller,
    ),
  );
}

describe('createJobExecution', () => {
  it('reads the run context live, following each scope of forEachScope', async () => {
    const seen = await inRun(async (execution) => {
      const scopes: (string | undefined)[] = [execution.getContext().scopeId];
      await execution.forEachScope(
        new Map([
          ['s-1', 1],
          ['s-2', 2],
        ]),
        async () => {
          scopes.push(execution.getContext().scopeId);
        },
      );
      return scopes;
    });
    expect(seen).toEqual([undefined, 's-1', 's-2']);
  });

  it('returns each scope result and passes the value and scopeId to fn', async () => {
    const result = await inRun((execution) =>
      execution.forEachScope(
        [
          ['s-1', 10],
          ['s-2', 20],
        ],
        async (value, scopeId) => `${scopeId}:${value}`,
      ),
    );
    expect(result).toEqual({
      succeeded: [
        { scopeId: 's-1', value: 's-1:10' },
        { scopeId: 's-2', value: 's-2:20' },
      ],
      failed: [],
      skipped: [],
    });
  });

  it('logs and records a failing scope without stopping the others', async () => {
    const { logger, error } = makeLogger();
    const boom = new Error('boom');
    const result = await inRun(
      (execution) =>
        execution.forEachScope(
          [
            ['s-1', 1],
            ['s-2', 2],
            ['s-3', 3],
          ],
          async (_value, scopeId) => {
            if (scopeId === 's-2') throw boom;
            return scopeId;
          },
        ),
      undefined,
      logger,
    );
    expect(result.succeeded.map((s) => s.scopeId)).toEqual(['s-1', 's-3']);
    expect(result.failed).toEqual([{ scopeId: 's-2', error: boom }]);
    expect(error).toHaveBeenCalledWith(expect.any(String), boom, { meta: { scopeId: 's-2' } });
  });

  it('skips the remaining scopes once aborted, without logging errors', async () => {
    const { logger, error } = makeLogger();
    const result = await inRun(
      (execution, controller) =>
        execution.forEachScope(
          [
            ['s-1', 1],
            ['s-2', 2],
            ['s-3', 3],
          ],
          async (_value, scopeId) => {
            if (scopeId === 's-2') {
              controller.abort();
              throw new Error('aborted mid-scope');
            }
            return scopeId;
          },
        ),
      undefined,
      logger,
    );
    expect(result.succeeded.map((s) => s.scopeId)).toEqual(['s-1']);
    expect(result.skipped).toEqual(['s-2', 's-3']);
    expect(result.failed).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('rejects forEachScope when the context is already scoped', async () => {
    const provider = new AsyncExecutionContextProvider();
    await expect(
      inRun(
        (execution) =>
          provider.withScope('outer', () => execution.forEachScope([['s-1', 1]], async () => {})),
        provider,
      ),
    ).rejects.toThrow(/already scoped to "outer"/);
  });

  it('throws when used outside its run', async () => {
    const execution = await inRun(async (e) => e);
    expect(() => execution.getContext()).toThrow(/outside its run/);
  });
});
