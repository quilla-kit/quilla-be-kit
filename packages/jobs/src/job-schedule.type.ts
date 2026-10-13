export const JobScheduleType = {
  Interval: 'interval',
} as const;
export type JobScheduleType = (typeof JobScheduleType)[keyof typeof JobScheduleType];

export type JobSchedule = {
  readonly type: typeof JobScheduleType.Interval;
  readonly everyMs: number;
  /** Delay before the first run; defaults to `everyMs`. `0` runs right after registration. */
  readonly initialDelayMs?: number;
};
