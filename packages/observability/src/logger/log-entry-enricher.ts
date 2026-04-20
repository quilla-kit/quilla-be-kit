import type { LogContext } from './log-entry.js';

export type LogEnricherContribution = {
  readonly context?: Partial<LogContext>;
  readonly extra?: Record<string, unknown>;
};

export interface LogEntryEnricher {
  enrich(): LogEnricherContribution;
}
