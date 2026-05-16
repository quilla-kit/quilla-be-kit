import { QuillaError } from './quilla.error.js';

export class UnauthorizedError extends QuillaError {
  readonly code: string = 'UNAUTHORIZED';
}
