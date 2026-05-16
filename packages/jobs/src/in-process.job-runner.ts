import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { Logger } from '@quilla-be-kit/observability';
import type { BackgroundJob } from './background-job.interface.js';
import type { JobRunner } from './job-runner.interface.js';
import { JobScheduleType } from './job-schedule.type.js';

export class InProcessJobRunner implements JobRunner {
  readonly name = 'InProcessJobRunner';
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly activeExecutions = new Map<string, Promise<void>>();

  constructor(
    private readonly executionContextProvider: ExecutionContextProvider,
    private readonly logger: Logger,
  ) {}

  register(job: BackgroundJob): void {
    if (this.timers.has(job.name)) return;

    const log = this.logger.forMethod('register');

    if (job.schedule.type !== JobScheduleType.Interval) {
      throw new Error(
        `InProcessJobRunner does not support schedule type "${(job.schedule as { type: string }).type}" (job "${job.name}")`,
      );
    }

    const timer = setInterval(() => {
      const ctx = this.executionContextProvider.factory.createSystemContext('job');
      const execution = this.executionContextProvider.runWithContext(ctx, async () => {
        try {
          log.debug(`Executing ${job.name}`);
          await job.execute();
        } catch (err) {
          log.error(`Job "${job.name}" failed`, err);
        }
      });

      this.activeExecutions.set(job.name, execution);
      void execution.finally(() => {
        if (this.activeExecutions.get(job.name) === execution) {
          this.activeExecutions.delete(job.name);
        }
      });
    }, job.schedule.everyMs);

    this.timers.set(job.name, timer);
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.activeExecutions.values()]);
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.drain();
  }
}
