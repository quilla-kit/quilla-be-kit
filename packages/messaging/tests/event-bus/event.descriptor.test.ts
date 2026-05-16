import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../../src/event-bus/event.descriptor.js';

describe('defineEvent', () => {
  it('captures the event name', () => {
    const e = defineEvent('order.placed');
    expect(e.name).toBe('order.placed');
  });

  it('omits schema when not provided', () => {
    const e = defineEvent('order.placed');
    expect(e.schema).toBeUndefined();
    expect('schema' in e).toBe(false);
  });

  it('captures a Standard Schema v1 instance when provided', () => {
    const schema = z.object({ orderId: z.string() });
    const e = defineEvent('order.placed', schema);
    expect(e.schema).toBe(schema);
  });

  it('produces an immutable descriptor', () => {
    const e = defineEvent('order.placed');
    expect(() => {
      (e as unknown as { name: string }).name = 'changed';
    }).toThrow();
  });

  it('carries the payload type parameter (compile-time check)', () => {
    type Payload = { id: string; total: number };
    const e = defineEvent<Payload>('order.placed');
    expect(e.name).toBe('order.placed');
    expectTypeOf(e.__payload).toEqualTypeOf<Payload | undefined>();
  });

  it('infers payload type from a zod schema', () => {
    const e = defineEvent('order.placed', z.object({ orderId: z.string() }));
    expectTypeOf(e.__payload).toEqualTypeOf<{ orderId: string } | undefined>();
  });
});
