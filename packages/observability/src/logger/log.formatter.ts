import type { LogEntry } from './log-entry.type.js';

export interface LogFormatter {
  format(entry: LogEntry): string;
}
