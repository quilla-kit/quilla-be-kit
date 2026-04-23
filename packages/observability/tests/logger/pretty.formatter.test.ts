import { describe, expect, it } from 'vitest';
import type { LogEntry } from '../../src/logger/log-entry.type.js';
import { PrettyFormatter } from '../../src/logger/pretty.formatter.js';

const formatter = new PrettyFormatter();

const baseEntry: LogEntry = {
  timestamp: '2026-04-20T10:00:00.000Z',
  level: 'info',
  service: 'test-service',
  module: 'TestModule',
  message: 'hello',
  context: {},
};

// Strips ANSI escape sequences so assertions are on plain text.
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[\\d+m`, 'g');
const strip = (s: string): string => s.replace(ANSI_RE, '');

describe('PrettyFormatter', () => {
  it('renders timestamp, level, service, module, and message on the first line', () => {
    const out = strip(formatter.format(baseEntry));
    const [first] = out.split('\n');
    expect(first).toContain('2026-04-20T10:00:00.000Z');
    expect(first).toContain('INFO');
    expect(first).toContain('[test-service]');
    expect(first).toContain('[TestModule]');
    expect(first).toContain('hello');
    expect(first?.indexOf('[test-service]') ?? -1).toBeLessThan(
      first?.indexOf('[TestModule]') ?? -1,
    );
  });

  it('renders context fields that are present', () => {
    const entry: LogEntry = {
      ...baseEntry,
      context: {
        scopeId: 'scope-1',
        userId: 'user-1',
        actorType: 'user',
        correlationId: 'corr-1',
      },
    };
    const out = strip(formatter.format(entry));
    expect(out).toContain('scopeId=scope-1');
    expect(out).toContain('userId=user-1');
    expect(out).toContain('actorType=user');
    expect(out).toContain('correlationId=corr-1');
  });

  it('omits the ctx line entirely when no context fields are present', () => {
    const out = strip(formatter.format(baseEntry));
    expect(out).not.toContain('ctx:');
  });

  it('includes module::location when location is set', () => {
    const entry: LogEntry = { ...baseEntry, location: 'myMethod' };
    const out = strip(formatter.format(entry));
    expect(out).toContain('[TestModule::myMethod]');
  });

  it('renders data/meta/extra as JSON lines', () => {
    const entry: LogEntry = {
      ...baseEntry,
      data: { email: 'a@b.c' },
      meta: { durationMs: 42 },
      extra: { http: { method: 'GET', path: '/' } },
    };
    const out = strip(formatter.format(entry));
    expect(out).toContain('data:');
    expect(out).toContain('"email":"a@b.c"');
    expect(out).toContain('meta:');
    expect(out).toContain('"durationMs":42');
    expect(out).toContain('extra:');
    expect(out).toContain('"method":"GET"');
  });

  it('renders error block with name, message, cause, and stack', () => {
    const entry: LogEntry = {
      ...baseEntry,
      level: 'error',
      error: {
        name: 'BoomError',
        message: 'kaboom',
        cause: 'upstream-timeout',
        stack: 'Error: kaboom\n    at somewhere (file.ts:1:1)',
      },
    };
    const out = strip(formatter.format(entry));
    expect(out).toContain('BoomError:');
    expect(out).toContain('kaboom');
    expect(out).toContain('cause:');
    expect(out).toContain('upstream-timeout');
    expect(out).toContain('at somewhere (file.ts:1:1)');
  });
});
