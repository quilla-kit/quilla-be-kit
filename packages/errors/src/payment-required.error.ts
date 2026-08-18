import { QuillaError } from './quilla.error.js';

export class PaymentRequiredError extends QuillaError {
  readonly code: string = 'PAYMENT_REQUIRED';
}
