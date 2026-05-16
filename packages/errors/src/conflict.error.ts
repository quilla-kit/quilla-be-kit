import { QuillaError } from './quilla.error.js';

export class ConflictError extends QuillaError {
  readonly code: string = 'CONFLICT';
}
