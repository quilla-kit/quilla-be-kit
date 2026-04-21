import { describe, expect, it } from 'vitest';
import { defineEvent } from '../../src/event-bus/event.descriptor.js';

describe('defineEvent', () => {
  it('captures the event name', () => {
    const e = defineEvent('order.placed');
    expect(e.name).toBe('order.placed');
  });

  it('captures the optional schema reference', () => {
    const e = defineEvent('order.placed', 'v1');
    expect(e.schema).toBe('v1');
  });

  it('omits schema when not provided', () => {
    const e = defineEvent('order.placed');
    expect(e.schema).toBeUndefined();
    expect('schema' in e).toBe(false);
  });

  it('produces an immutable descriptor', () => {
    const e = defineEvent('order.placed', 'v1');
    expect(() => {
      (e as unknown as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('carries the payload type parameter (compile-time check)', () => {
    type Payload = { id: string; total: number };
    const e = defineEvent<Payload>('order.placed');
    // Type-level: handler argument payload is inferred as Payload via the descriptor.
    // We verify runtime identity here; compile success is the type assertion.
    expect(e.name).toBe('order.placed');
  });
});
