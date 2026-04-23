import type { LogEntryEnricher } from './log-entry.enricher.js';
import type { LogContext, LogEntry, LogLevel, SerializedError } from './log-entry.type.js';
import type { LogFormatter } from './log.formatter.js';
import type { LogObserver } from './log.observer.js';
import type { LogParams, Logger } from './logger.interface.js';
import type { LogObfuscator } from './obfuscation/log.obfuscator.js';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export type StructuredLoggerConfig = {
  readonly level: LogLevel;
};

export type StructuredLoggerDependencies = {
  readonly service: string;
  readonly module: string;
  readonly config: StructuredLoggerConfig;
  readonly formatter: LogFormatter;
  readonly enrichers: readonly LogEntryEnricher[];
  readonly observers: readonly LogObserver[];
  readonly obfuscator?: LogObfuscator;
  readonly location?: string;
  readonly baseMeta?: Record<string, unknown>;
};

/**
 * Core `Logger` implementation. Emits asynchronously (fire-and-forget from the
 * caller's perspective) so that obfuscation can be applied without blocking the
 * hot path. Call `flush()` before process exit to await in-flight emissions.
 *
 * Enricher and observer errors are silently swallowed — logging must never
 * surface errors to the caller.
 */
export class StructuredLogger implements Logger {
  private readonly service: string;
  private readonly module: string;
  private readonly config: StructuredLoggerConfig;
  private readonly formatter: LogFormatter;
  private readonly enrichers: readonly LogEntryEnricher[];
  private readonly observers: readonly LogObserver[];
  private readonly obfuscator: LogObfuscator | undefined;
  private readonly location: string | undefined;
  private readonly baseMeta: Record<string, unknown> | undefined;
  private readonly inflight = new Set<Promise<void>>();

  constructor(deps: StructuredLoggerDependencies) {
    this.service = deps.service;
    this.module = deps.module;
    this.config = deps.config;
    this.formatter = deps.formatter;
    this.enrichers = deps.enrichers;
    this.observers = deps.observers;
    this.obfuscator = deps.obfuscator;
    this.location = deps.location;
    this.baseMeta = deps.baseMeta;
  }

  debug(message: string, params?: LogParams): void {
    this.schedule('debug', message, undefined, params);
  }

  info(message: string, params?: LogParams): void {
    this.schedule('info', message, undefined, params);
  }

  warn(message: string, params?: LogParams): void {
    this.schedule('warn', message, undefined, params);
  }

  error(message: string, error?: unknown, params?: LogParams): void {
    this.schedule('error', message, error, params);
  }

  forMethod(name: string): Logger {
    return this.clone({ location: name });
  }

  withMeta(meta: Record<string, unknown>): Logger {
    return this.clone({ baseMeta: { ...(this.baseMeta ?? {}), ...meta } });
  }

  private clone(override: Partial<StructuredLoggerDependencies>): StructuredLogger {
    return new StructuredLogger({
      service: this.service,
      module: this.module,
      config: this.config,
      formatter: this.formatter,
      enrichers: this.enrichers,
      observers: this.observers,
      ...(this.obfuscator !== undefined ? { obfuscator: this.obfuscator } : {}),
      ...(this.location !== undefined ? { location: this.location } : {}),
      ...(this.baseMeta !== undefined ? { baseMeta: this.baseMeta } : {}),
      ...override,
    });
  }

  /** Awaits all in-flight emissions. Use before process exit in graceful shutdown. */
  async flush(): Promise<void> {
    await Promise.all(this.inflight);
  }

  private schedule(
    level: LogLevel,
    message: string,
    error: unknown,
    params: LogParams | undefined,
  ): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.config.level]) return;
    const promise = this.emit(level, message, error, params).finally(() => {
      this.inflight.delete(promise);
    });
    this.inflight.add(promise);
  }

  private async emit(
    level: LogLevel,
    message: string,
    error: unknown,
    params: LogParams | undefined,
  ): Promise<void> {
    const rawData = params?.data;
    const callMeta = params?.meta;
    const meta =
      this.baseMeta !== undefined && callMeta !== undefined
        ? { ...this.baseMeta, ...callMeta }
        : (callMeta ?? this.baseMeta);

    let context: LogContext = {};
    let extra: Record<string, unknown> | undefined;

    for (const enricher of this.enrichers) {
      try {
        const contribution = enricher.enrich();
        if (contribution.context !== undefined) {
          context = { ...context, ...contribution.context };
        }
        if (contribution.extra !== undefined) {
          extra = { ...(extra ?? {}), ...contribution.extra };
        }
      } catch {
        // enricher errors must never surface
      }
    }

    let data: Record<string, unknown> | undefined = rawData;
    if (rawData !== undefined && this.obfuscator !== undefined) {
      try {
        data = await this.obfuscator.obfuscate(rawData);
      } catch {
        data = { _obfuscationError: true };
      }
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      module: this.module,
      ...(this.location !== undefined ? { location: this.location } : {}),
      message,
      context,
      ...(data !== undefined ? { data } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(extra !== undefined ? { extra } : {}),
      ...(error !== undefined ? { error: this.serializeError(error) } : {}),
    };

    for (const observer of this.observers) {
      try {
        observer.onEntry(entry);
      } catch {
        // observer errors must never surface
      }
    }

    const output = this.formatter.format(entry);
    if (level === 'error' || level === 'warn') {
      console.error(output);
    } else {
      console.log(output);
    }
  }

  private serializeError(error: unknown): SerializedError {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
        ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
      };
    }
    return {
      name: 'UnknownError',
      message: String(error),
    };
  }
}
