import { QuillaError } from './quilla.error.js';

export class ValidationError extends QuillaError {
  readonly code: string = 'VALIDATION';
}
