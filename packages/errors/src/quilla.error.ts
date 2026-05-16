const QUILLA_ERROR = Symbol.for('quilla-be-kit.error');

export type QuillaErrorOptions = {
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
};

export type QuillaErrorJSON = {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;
};

export abstract class QuillaError extends Error {
  readonly [QUILLA_ERROR] = true as const;
  abstract readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(options: QuillaErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    if (options.context !== undefined) {
      this.context = options.context;
    }
  }

  toJSON(): QuillaErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.context !== undefined ? { context: this.context } : {}),
      ...(this.cause !== undefined ? { cause: this.cause } : {}),
    };
  }

  static is(e: unknown): e is QuillaError {
    return (
      typeof e === 'object' &&
      e !== null &&
      (e as Record<PropertyKey, unknown>)[QUILLA_ERROR] === true
    );
  }
}
