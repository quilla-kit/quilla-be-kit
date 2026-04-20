import { QuillaError } from './quilla.error.js';

export class NotFoundError extends QuillaError {
  readonly code: string = 'NOT_FOUND';
}
