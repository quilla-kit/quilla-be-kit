import { describe, expect, it } from 'vitest';
import { NoopLogger } from '../../src/logger/noop-logger.js';

describe('NoopLogger', () => {
  it('does not throw on any level', () => {
    const logger = new NoopLogger();
    expect(() => logger.debug('x')).not.toThrow();
    expect(() => logger.info('x')).not.toThrow();
    expect(() => logger.warn('x')).not.toThrow();
    expect(() => logger.error('x', new Error('boom'))).not.toThrow();
  });

  it('forMethod returns a Logger', () => {
    const logger = new NoopLogger();
    const child = logger.forMethod('anyMethod');
    expect(() => child.info('x')).not.toThrow();
  });
});
