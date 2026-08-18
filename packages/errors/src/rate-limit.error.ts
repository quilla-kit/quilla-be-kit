import { QuillaError } from './quilla.error.js';

export class RateLimitError extends QuillaError {
  readonly code: string = 'RATE_LIMIT';
}
