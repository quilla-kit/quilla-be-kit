import { ConflictError, QuillaError } from '@quilla-be-kit/errors';

export class JobLeaseLostError extends ConflictError {
  override readonly code = 'JOB_LEASE_LOST';
  readonly jobName: string;

  constructor(jobName: string) {
    super({
      message: `lease on job ${jobName} is no longer held by this instance`,
      context: { jobName },
    });
    this.jobName = jobName;
  }

  // Matches by code rather than instanceof so duplicate package installs still match.
  static override is(e: unknown): e is JobLeaseLostError {
    return QuillaError.is(e) && e.code === 'JOB_LEASE_LOST';
  }
}
