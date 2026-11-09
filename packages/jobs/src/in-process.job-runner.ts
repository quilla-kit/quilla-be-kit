import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { Logger } from '@quilla-be-kit/observability';
import type { BackgroundJob } from './background-job.interface.js';
import { createJobExecution } from './job-execution.factory.js';
import type { JobLeaseStore } from './job-lease-store.interface.js';
import { JobLeaseManager, assertLeaseMs } from './job-lease.manager.js';
import { JobInstances } from './job-run-on.type.js';
import type { JobRunner } from './job-runner.interface.js';
import { JobScheduleType } from './job-schedule.type.js';

const MAX_TIMER_MS = 2_147_483_647;
const MIN_ANY_EVERY_MS = 1000;

export type InProcessJobRunnerOptions = {
  /** Required to register `'any'` jobs. */
  readonly leaseStore?: JobLeaseStore | undefined;
  /** Recorded as the lease holder; defaults to a random UUID. */
  readonly instanceId?: string | undefined;
  /** Default lease for `'any'` jobs; how long a dead holder keeps a job. Defaults to 60 s. */
  readonly leaseMs?: number | undefined;
};

type JobRun = (signal: AbortSignal) => Promise<void>;

type Registration = {
  readonly job: BackgroundJob;
  readonly log: Logger;
  readonly run: JobRun;
  readonly grid: { anchor: number; index: number };
};

type InFlight = {
  readonly execution: Promise<void>;
  readonly controller: AbortController;
};

function isTimerMs(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIMER_MS;
}

export class InProcessJobRunner implements JobRunner {
  readonly name = 'InProcessJobRunner';
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly leases: JobLeaseManager | null;

  constructor(
    private readonly executionContextProvider: ExecutionContextProvider,
    private readonly logger: Logger,
    options: InProcessJobRunnerOptions = {},
  ) {
    this.leases = options.leaseStore
      ? new JobLeaseManager({
          store: options.leaseStore,
          logger,
          instanceId: options.instanceId,
          leaseMs: options.leaseMs,
        })
      : null;
  }

  register(job: BackgroundJob): void {
    if (this.timers.has(job.name)) return;

    const log = this.logger.forMethod('register');

    if (job.schedule.type !== JobScheduleType.Interval) {
      throw new Error(
        `InProcessJobRunner does not support schedule type "${(job.schedule as { type: string }).type}" (job "${job.name}")`,
      );
    }
    const run = this.prepare(job, log);

    const firstDelay = job.schedule.initialDelayMs ?? job.schedule.everyMs;
    const grid = { anchor: Date.now() + firstDelay, index: 0 };
    this.arm({ job, log, run, grid }, firstDelay);
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((f) => f.execution));
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.drain();
  }

  // Validates the job and resolves how each tick runs it.
  private prepare(job: BackgroundJob, log: Logger): JobRun {
    const fail = (message: string) =>
      new Error(`InProcessJobRunner ${message} (job "${job.name}")`);
    const { everyMs, initialDelayMs, jitterMs } = job.schedule;

    if (!(isTimerMs(everyMs) && everyMs > 0)) {
      throw fail(`requires everyMs to be a finite number > 0 and <= ${MAX_TIMER_MS}`);
    }
    if (initialDelayMs !== undefined && !isTimerMs(initialDelayMs)) {
      throw fail(`requires initialDelayMs to be a finite number >= 0 and <= ${MAX_TIMER_MS}`);
    }
    if (
      jitterMs !== undefined &&
      !(isTimerMs(jitterMs) && jitterMs < everyMs && everyMs + jitterMs <= MAX_TIMER_MS)
    ) {
      throw fail('requires jitterMs to be a finite number >= 0 and below everyMs');
    }

    const runLog = this.logger.forMethod('execute').withMeta({ jobName: job.name });
    const execute: JobRun = (signal) => this.execute(job, log, runLog, signal);
    const runOn = job.runOn;
    if (!runOn || runOn.instances === JobInstances.All) return execute;
    if (runOn.instances !== JobInstances.Any) {
      throw fail(
        `does not support runOn.instances "${(runOn as { instances: string }).instances}"`,
      );
    }

    const leases = this.leases;
    if (!leases) throw fail(`needs a leaseStore to register an 'any' job`);
    const { leaseMs } = runOn;
    if (leaseMs !== undefined) assertLeaseMs(leaseMs, 'InProcessJobRunner', job.name);
    if (everyMs < MIN_ANY_EVERY_MS) {
      throw fail(`requires everyMs >= ${MIN_ANY_EVERY_MS} on an 'any' job`);
    }
    if (jitterMs) throw fail(`does not allow jitterMs on an 'any' job`);

    // Slack absorbs timer and query latency, so the holder's next tick is always due.
    const cooldownMs = everyMs - Math.min(Math.floor(everyMs / 10), 1000);
    return async (signal) => {
      try {
        const ran = await leases.run(job.name, { cooldownMs, leaseMs, signal }, execute);
        if (!ran) log.debug(`Skipping ${job.name}: held by another instance or not due yet`);
      } catch {
        // Store outage, logged by the lease manager: skip this tick.
      }
    };
  }

  private arm(registration: Registration, delayMs: number): void {
    const timer = setTimeout(() => {
      this.armNext(registration);
      this.tick(registration);
    }, delayMs);
    this.timers.set(registration.job.name, timer);
  }

  // Runs on a fixed grid from the first run, so runs don't drift. A slot already past (blocked
  // event loop, clock stepped forward) is skipped rather than caught up; a clock stepped back
  // re-anchors the grid instead of stalling the job.
  private armNext(registration: Registration): void {
    const { grid } = registration;
    const { everyMs, jitterMs } = registration.job.schedule;
    const now = Date.now();
    grid.index += 1;
    let next = grid.anchor + grid.index * everyMs;
    if (next <= now) {
      grid.index = Math.floor((now - grid.anchor) / everyMs) + 1;
      next = grid.anchor + grid.index * everyMs;
    } else if (next - now > everyMs) {
      grid.anchor = now + everyMs;
      grid.index = 0;
      next = grid.anchor;
    }
    const jitter = jitterMs ? Math.random() * jitterMs : 0;
    this.arm(registration, next - now + jitter);
  }

  private tick({ job, log, run }: Registration): void {
    if (this.inFlight.has(job.name)) {
      log.debug(`Skipping ${job.name}: previous run still in progress`);
      return;
    }

    const controller = new AbortController();
    const ctx = this.executionContextProvider.factory.createSystemContext('job');
    const execution = this.executionContextProvider.runWithContext(ctx, () =>
      run(controller.signal),
    );

    this.inFlight.set(job.name, { execution, controller });
    void execution.finally(() => this.inFlight.delete(job.name));
  }

  private async execute(
    job: BackgroundJob,
    log: Logger,
    runLog: Logger,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      log.debug(`Executing ${job.name}`);
      const provider = this.executionContextProvider;
      const execution = createJobExecution({
        provider,
        context: provider.getContext(),
        logger: runLog,
        signal,
      });
      await job.execute(signal, execution);
    } catch (err) {
      log.error(`Job "${job.name}" failed`, err);
    }
  }
}
