import { QuillaError } from './quilla.error.js';

export class UnavailableError extends QuillaError {
  readonly code: string = 'UNAVAILABLE';
}
