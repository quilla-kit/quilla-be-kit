export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  readonly scopeId?: string;
  readonly userId?: string;
  readonly actorType?: string;
  readonly correlationId?: string;
};

export type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: string;
};

export type LogEntry = {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly module: string;
  readonly location?: string;
  readonly message: string;
  readonly context: LogContext;
  readonly data?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
  readonly extra?: Record<string, unknown>;
  readonly error?: SerializedError;
};
