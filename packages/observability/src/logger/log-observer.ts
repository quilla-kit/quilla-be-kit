import type { LogEntry } from './log-entry.js';

export interface LogObserver {
  onEntry(entry: LogEntry): void;
}
