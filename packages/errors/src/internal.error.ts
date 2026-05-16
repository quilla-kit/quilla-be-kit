import { QuillaError } from './quilla.error.js';

export class InternalError extends QuillaError {
  readonly code: string = 'INTERNAL';
}
