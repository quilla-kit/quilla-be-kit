import { QuillaError } from './quilla.error.js';

export class ExternalError extends QuillaError {
  readonly code: string = 'EXTERNAL';
}
