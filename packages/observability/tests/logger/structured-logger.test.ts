import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonFormatter } from '../../src/logger/json-formatter.js';
import type { LogEntryEnricher } from '../../src/logger/log-entry-enricher.js';
import type { LogEntry } from '../../src/logger/log-entry.js';
import type { LogObserver } from '../../src/logger/log-observer.js';
import type { LogObfuscator } from '../../src/logger/obfuscation/log-obfuscator.js';
import { StructuredLogger } from '../../src/logger/structured-logger.js';

const baseDeps = {
  module: 'TestModule',
  config: { level: 'debug' as const },
  formatter: new JsonFormatter(),
  enrichers: [] as LogEntryEnricher[],
  observers: [] as LogObserver[],
};

describe('StructuredLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes info/debug to console.log and warn/error to console.error', async () => {
    const logger = new StructuredLogger(baseDeps);
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await logger.flush();

    expect(console.log).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('drops entries below the configured level', async () => {
    const logger = new StructuredLogger({ ...baseDeps, config: { level: 'warn' } });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await logger.flush();

    expect(console.log).toHaveBeenCalledTimes(0);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it('applies enrichers to context and extra, letting later enrichers override', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const enricherA: LogEntryEnricher = {
      enrich: () => ({ context: { scopeId: 'A', userId: 'a' }, extra: { trace: 't-a' } }),
    };
    const enricherB: LogEntryEnricher = {
      enrich: () => ({ context: { scopeId: 'B' }, extra: { region: 'eu' } }),
    };

    const logger = new StructuredLogger({
      ...baseDeps,
      enrichers: [enricherA, enricherB],
      observers: [observer],
    });
    logger.info('hi');
    await logger.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.context).toEqual({ scopeId: 'B', userId: 'a' });
    expect(captured[0]?.extra).toEqual({ trace: 't-a', region: 'eu' });
  });

  it('silently swallows enricher errors', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const enricher: LogEntryEnricher = {
      enrich: () => {
        throw new Error('enricher boom');
      },
    };

    const logger = new StructuredLogger({
      ...baseDeps,
      enrichers: [enricher],
      observers: [observer],
    });
    logger.info('hi');
    await logger.flush();

    expect(captured).toHaveLength(1);
  });

  it('silently swallows observer errors', async () => {
    const bad: LogObserver = {
      onEntry: () => {
        throw new Error('observer boom');
      },
    };
    const logger = new StructuredLogger({ ...baseDeps, observers: [bad] });
    expect(() => logger.info('x')).not.toThrow();
    await logger.flush();
  });

  it('notifies observers with the full entry', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const logger = new StructuredLogger({ ...baseDeps, observers: [observer] });
    logger.info('hi', { data: { secret: 'x' }, meta: { count: 1 } });
    await logger.flush();

    expect(captured[0]?.module).toBe('TestModule');
    expect(captured[0]?.level).toBe('info');
    expect(captured[0]?.data).toEqual({ secret: 'x' });
    expect(captured[0]?.meta).toEqual({ count: 1 });
  });

  it('obfuscates data through the obfuscator when configured', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const obfuscator: LogObfuscator = {
      obfuscate: async (d) =>
        Object.fromEntries(Object.entries(d).map(([k, v]) => [k, `HMAC(${String(v)})`])),
    };

    const logger = new StructuredLogger({ ...baseDeps, obfuscator, observers: [observer] });
    logger.info('hi', { data: { email: 'a@b.c' }, meta: { plain: 'untouched' } });
    await logger.flush();

    expect(captured[0]?.data).toEqual({ email: 'HMAC(a@b.c)' });
    expect(captured[0]?.meta).toEqual({ plain: 'untouched' });
  });

  it('replaces data with { _obfuscationError: true } when obfuscation throws', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const failing: LogObfuscator = {
      obfuscate: async () => {
        throw new Error('obfuscator boom');
      },
    };

    const logger = new StructuredLogger({
      ...baseDeps,
      obfuscator: failing,
      observers: [observer],
    });
    logger.info('hi', { data: { email: 'a@b.c' } });
    await logger.flush();

    expect(captured[0]?.data).toEqual({ _obfuscationError: true });
  });

  it('forMethod produces a child logger with the given location', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const logger = new StructuredLogger({ ...baseDeps, observers: [observer] });
    const child = logger.forMethod('handle');
    child.info('hi');
    await (child as StructuredLogger).flush();

    expect(captured[0]?.location).toBe('handle');
  });

  it('serializes Error instances with name, message, and stack', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const logger = new StructuredLogger({ ...baseDeps, observers: [observer] });
    logger.error('failed', new Error('kaboom'));
    await logger.flush();

    expect(captured[0]?.error?.name).toBe('Error');
    expect(captured[0]?.error?.message).toBe('kaboom');
    expect(captured[0]?.error?.stack).toBeDefined();
  });

  it('serializes non-Error thrown values as UnknownError', async () => {
    const captured: LogEntry[] = [];
    const observer: LogObserver = { onEntry: (e) => captured.push(e) };
    const logger = new StructuredLogger({ ...baseDeps, observers: [observer] });
    logger.error('failed', 'string-thrown-value');
    await logger.flush();

    expect(captured[0]?.error?.name).toBe('UnknownError');
    expect(captured[0]?.error?.message).toBe('string-thrown-value');
  });
});
