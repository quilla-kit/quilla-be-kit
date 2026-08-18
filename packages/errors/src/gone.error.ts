import { QuillaError } from './quilla.error.js';

export class GoneError extends QuillaError {
  readonly code: string = 'GONE';
}
