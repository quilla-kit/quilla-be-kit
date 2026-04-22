import type { JobSchedule } from './job-schedule.type.js';

export interface BackgroundJob {
  readonly name: string;
  readonly schedule: JobSchedule;
  execute(): Promise<void>;
}
