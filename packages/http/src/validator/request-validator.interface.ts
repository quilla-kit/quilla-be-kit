import type { ValidationResult } from './validation-result.type.js';

export interface RequestValidator {
  validate(schema: unknown, input: unknown): ValidationResult;
}
