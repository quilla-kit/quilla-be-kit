import { QuillaError } from './quilla.error.js';

export class NotImplementedError extends QuillaError {
  readonly code: string = 'NOT_IMPLEMENTED';
}
