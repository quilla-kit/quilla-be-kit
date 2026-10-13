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

    const { everyMs, initialDelayMs } = job.schedule;
    if (initialDelayMs !== undefined && !(Number.isFinite(initialDelayMs) && initialDelayMs >= 0)) {
      throw new Error(
        `InProcessJobRunner requires initialDelayMs to be a finite number >= 0 (job "${job.name}")`,
      );
    }

    const tick = () => this.tick(job, log);
    const first = setTimeout(() => {
      tick();
      this.timers.set(job.name, setInterval(tick, everyMs));
    }, initialDelayMs ?? everyMs);
    this.timers.set(job.name, first);
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

  private tick(job: BackgroundJob, log: Logger): void {
    if (this.activeExecutions.has(job.name)) {
      log.debug(`Skipping ${job.name}: previous run still in progress`);
      return;
    }

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
    void execution.finally(() => this.activeExecutions.delete(job.name));
  }
}
