import type { JobExecution } from './job-execution.type.js';
import type { JobRunOn } from './job-run-on.type.js';
import type { JobSchedule } from './job-schedule.type.js';

export interface BackgroundJob {
  readonly name: string;
  readonly schedule: JobSchedule;
  /** Defaults to `{ instances: 'all' }`: every instance that registers the job runs it. */
  readonly runOn?: JobRunOn | undefined;
  /**
   * `signal` aborts when the runner stops and, for `'any'` jobs, when the lease is lost.
   * `execution` reads the run's context and runs work once per scope.
   */
  execute(signal: AbortSignal, execution: JobExecution): Promise<void>;
}
