import { QuillaError } from './quilla.error.js';

export class PreconditionFailedError extends QuillaError {
  readonly code: string = 'PRECONDITION_FAILED';
}
