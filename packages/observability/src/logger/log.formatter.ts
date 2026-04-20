import type { LogEntry } from './log.entry.js';

export interface LogFormatter {
  format(entry: LogEntry): string;
}
