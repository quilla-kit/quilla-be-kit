import type { LogParams, Logger } from './logger.js';

/** Silent logger — useful in tests and code paths that opt out of logging. */
export class NoopLogger implements Logger {
  debug(_message: string, _params?: LogParams): void {}
  info(_message: string, _params?: LogParams): void {}
  warn(_message: string, _params?: LogParams): void {}
  error(_message: string, _error?: unknown, _params?: LogParams): void {}
  forMethod(_name: string): Logger {
    return this;
  }
}
