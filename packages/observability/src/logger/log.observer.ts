import type { LogEntry } from './log-entry.type.js';

export interface LogObserver {
  onEntry(entry: LogEntry): void;
}
