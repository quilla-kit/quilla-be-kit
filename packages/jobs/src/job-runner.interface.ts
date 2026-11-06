import type { Disposable } from '@quilla-be-kit/runtime';
import type { BackgroundJob } from './background-job.interface.js';

export interface JobRunner extends Disposable {
  /**
   * Must honor every `JobSchedule` field (e.g. `initialDelayMs`) and `runOn`, and pass an
   * `AbortSignal` to `execute`, or throw on jobs it can't honor.
   */
  register(job: BackgroundJob): void;
  stop(): void;
  /**
   * Awaits any in-flight job ticks. Call after `stop()` so no tick is
   * abandoned mid-execution. `dispose()` is `stop()` + `drain()`.
   */
  drain(): Promise<void>;
}
