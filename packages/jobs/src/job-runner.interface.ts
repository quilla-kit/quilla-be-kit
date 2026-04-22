import type { Disposable } from '@quilla-kit/runtime';
import type { BackgroundJob } from './background-job.interface.js';

export interface JobRunner extends Disposable {
  register(job: BackgroundJob): void;
  stop(): void;
  /**
   * Awaits any in-flight job ticks. Call after `stop()` so no tick is
   * abandoned mid-execution. `dispose()` is `stop()` + `drain()`.
   */
  drain(): Promise<void>;
}
