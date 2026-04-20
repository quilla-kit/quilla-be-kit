import { JsonFormatter } from './json.formatter.js';
import type { LogEntryEnricher } from './log-entry.enricher.js';
import type { LogLevel } from './log.entry.js';
import type { LogFormatter } from './log.formatter.js';
import type { LogObserver } from './log.observer.js';
import type { Logger } from './logger.js';
import type { LogObfuscator } from './obfuscation/log.obfuscator.js';
import { PrettyFormatter } from './pretty.formatter.js';
import { StructuredLogger } from './structured.logger.js';

export type LogOutputMode = 'json' | 'pretty';

export type LoggerConfig = {
  /** Minimum level to emit. Entries below this level are dropped. */
  readonly level: LogLevel;
  /** `json` for production aggregators; `pretty` for local development. */
  readonly mode: LogOutputMode;
};

export interface LoggerFactory {
  /** Returns a logger scoped to a module name (typically the class or service name). */
  create(module: string): Logger;
}

export type LoggerFactoryOptions = {
  readonly config: LoggerConfig;
  /** Override the formatter selected by `config.mode`. */
  readonly formatter?: LogFormatter;
  readonly enrichers?: readonly LogEntryEnricher[];
  readonly observers?: readonly LogObserver[];
  /** When provided, the PII `data` bucket on every emitted entry is obfuscated. */
  readonly obfuscator?: LogObfuscator;
};

/**
 * Constructs a `LoggerFactory` configured with shared formatter, enrichers,
 * observers, and (optionally) an obfuscator. All loggers created from the
 * returned factory share these dependencies.
 */
export function createLoggerFactory(opts: LoggerFactoryOptions): LoggerFactory {
  const formatter: LogFormatter =
    opts.formatter ?? (opts.config.mode === 'json' ? new JsonFormatter() : new PrettyFormatter());
  const enrichers = opts.enrichers ?? [];
  const observers = opts.observers ?? [];

  return {
    create(module: string): Logger {
      return new StructuredLogger({
        module,
        config: { level: opts.config.level },
        formatter,
        enrichers,
        observers,
        ...(opts.obfuscator !== undefined ? { obfuscator: opts.obfuscator } : {}),
      });
    },
  };
}
