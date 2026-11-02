import { ConflictError, QuillaError } from '@quilla-be-kit/errors';

export class ClaimLostError extends ConflictError {
  override readonly code = 'CLAIM_LOST';
  readonly id: string;

  constructor(id: string) {
    super({ message: `claim on ${id} is no longer held by this instance`, context: { id } });
    this.id = id;
  }

  // Matches by code rather than instanceof so duplicate package installs still match.
  static override is(e: unknown): e is ClaimLostError {
    return QuillaError.is(e) && e.code === 'CLAIM_LOST';
  }
}
