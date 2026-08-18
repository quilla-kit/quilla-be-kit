import { QuillaError } from './quilla.error.js';

export class TimeoutError extends QuillaError {
  readonly code: string = 'TIMEOUT';
}
