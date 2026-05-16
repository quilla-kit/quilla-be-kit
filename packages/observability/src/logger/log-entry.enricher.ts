import type { LogContext } from './log-entry.type.js';

export type LogEnricherContribution = {
  readonly context?: Partial<LogContext>;
  readonly extra?: Record<string, unknown>;
};

export interface LogEntryEnricher {
  enrich(): LogEnricherContribution;
}
