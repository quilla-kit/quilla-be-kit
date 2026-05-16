import { QuillaError } from './quilla.error.js';

export class ForbiddenError extends QuillaError {
  readonly code: string = 'FORBIDDEN';
}
