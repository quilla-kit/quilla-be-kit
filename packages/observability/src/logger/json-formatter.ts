import type { LogEntry } from './log-entry.js';
import type { LogFormatter } from './log-formatter.js';

/**
 * Produces a single-line JSON string per log entry. Designed for production
 * log aggregation (Datadog, Splunk, Loki, CloudWatch, etc.).
 */
export class JsonFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    return JSON.stringify(entry);
  }
}
