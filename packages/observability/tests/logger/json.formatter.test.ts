import { describe, expect, it } from 'vitest';
import { JsonFormatter } from '../../src/logger/json.formatter.js';
import type { LogEntry } from '../../src/logger/log.entry.js';

const formatter = new JsonFormatter();

const baseEntry: LogEntry = {
  timestamp: '2026-04-20T10:00:00.000Z',
  level: 'info',
  module: 'TestModule',
  message: 'hello',
  context: {},
};

describe('JsonFormatter', () => {
  it('produces a single-line JSON string', () => {
    const out = formatter.format(baseEntry);
    expect(out.includes('\n')).toBe(false);
    expect(JSON.parse(out)).toEqual(baseEntry);
  });

  it('omits absent optional fields from the output', () => {
    const parsed = JSON.parse(formatter.format(baseEntry)) as Record<string, unknown>;
    expect(parsed.location).toBeUndefined();
    expect(parsed.data).toBeUndefined();
    expect(parsed.meta).toBeUndefined();
    expect(parsed.extra).toBeUndefined();
    expect(parsed.error).toBeUndefined();
  });

  it('includes error payload when present', () => {
    const entry: LogEntry = {
      ...baseEntry,
      level: 'error',
      error: { name: 'BoomError', message: 'kaboom' },
    };
    const parsed = JSON.parse(formatter.format(entry)) as LogEntry;
    expect(parsed.error).toEqual({ name: 'BoomError', message: 'kaboom' });
  });
});
