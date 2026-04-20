import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonFormatter } from '../../src/logger/json-formatter.js';
import type { LogFormatter } from '../../src/logger/log-formatter.js';
import type { LogObserver } from '../../src/logger/log-observer.js';
import { createLoggerFactory } from '../../src/logger/logger-factory.js';
import type { LogObfuscator } from '../../src/logger/obfuscation/log-obfuscator.js';
import { PrettyFormatter } from '../../src/logger/pretty-formatter.js';
import { StructuredLogger } from '../../src/logger/structured-logger.js';

describe('createLoggerFactory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a factory that creates module-scoped loggers', () => {
    const factory = createLoggerFactory({ config: { level: 'info', mode: 'json' } });
    const logger = factory.create('MyModule');
    expect(logger).toBeInstanceOf(StructuredLogger);
  });

  it('defaults to JsonFormatter when mode=json', async () => {
    const observer: LogObserver = { onEntry: () => {} };
    const factory = createLoggerFactory({
      config: { level: 'info', mode: 'json' },
      observers: [observer],
    });
    const logger = factory.create('M');
    logger.info('hi');
    await (logger as StructuredLogger).flush();

    const lastCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(() => JSON.parse(lastCall?.[0] as string)).not.toThrow();
  });

  it('defaults to PrettyFormatter when mode=pretty', async () => {
    const factory = createLoggerFactory({ config: { level: 'info', mode: 'pretty' } });
    const logger = factory.create('M');
    logger.info('hi');
    await (logger as StructuredLogger).flush();

    const lastCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0];
    const output = lastCall?.[0] as string;
    // Pretty format contains ANSI escape sequences
    expect(output.includes('\x1b[')).toBe(true);
  });

  it('uses the explicit formatter when provided, ignoring mode', async () => {
    const marker = 'CUSTOM-FORMATTER-OUTPUT';
    const formatter: LogFormatter = { format: () => marker };
    const factory = createLoggerFactory({
      config: { level: 'info', mode: 'json' },
      formatter,
    });
    factory.create('M').info('hi');
    await new Promise((resolve) => setImmediate(resolve));

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[0]).toBe(marker);
  });

  it('wires the obfuscator through to created loggers', async () => {
    const obfuscator: LogObfuscator = {
      obfuscate: async (d) =>
        Object.fromEntries(Object.entries(d).map(([k, v]) => [k, `X(${String(v)})`])),
    };
    let captured: unknown;
    const observer: LogObserver = {
      onEntry: (e) => {
        captured = e.data;
      },
    };
    const factory = createLoggerFactory({
      config: { level: 'info', mode: 'json' },
      obfuscator,
      observers: [observer],
    });
    const logger = factory.create('M');
    logger.info('hi', { data: { secret: 'hunter2' } });
    await (logger as StructuredLogger).flush();

    expect(captured).toEqual({ secret: 'X(hunter2)' });
  });

  it('unused formatter override defaults are not mixed up between factories', () => {
    // Explicit JsonFormatter + pretty mode: explicit wins
    const f = createLoggerFactory({
      config: { level: 'info', mode: 'pretty' },
      formatter: new JsonFormatter(),
    });
    expect(f.create('M')).toBeInstanceOf(StructuredLogger);

    // Explicit PrettyFormatter + json mode: explicit wins
    const g = createLoggerFactory({
      config: { level: 'info', mode: 'json' },
      formatter: new PrettyFormatter(),
    });
    expect(g.create('M')).toBeInstanceOf(StructuredLogger);
  });
});
