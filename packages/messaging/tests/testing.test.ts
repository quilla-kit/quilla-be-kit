import { testContextView } from '@quilla-be-kit/execution-context/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ScopedHandlerEntry } from '../src/event-bus/handler-entry.type.js';
import { createTestHandlerEntry } from '../src/testing.js';

describe('createTestHandlerEntry', () => {
  it('fills the envelope with defaults and an unscoped context', () => {
    const entry = createTestHandlerEntry({ orderId: 'o-1' });
    expect(entry).toMatchObject({
      payload: { orderId: 'o-1' },
      eventType: 'test.event',
      eventVersion: 1,
    });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry.occurredAt).toBeInstanceOf(Date);
    expect(entry.getContext().scopeId).toBeUndefined();
  });

  it('types a scoped context as a ScopedHandlerEntry', () => {
    const entry = createTestHandlerEntry(
      { orderId: 'o-1' },
      { context: testContextView({ scopeId: 'tenant-1' }) },
    );
    expectTypeOf(entry).toMatchTypeOf<ScopedHandlerEntry<{ orderId: string }>>();
    expect(entry.getContext().scopeId).toBe('tenant-1');
  });

  it('applies field overrides', () => {
    const entry = createTestHandlerEntry(1, {
      fields: { eventType: 'order.placed', aggregateId: 'a-1' },
    });
    expect(entry).toMatchObject({ eventType: 'order.placed', aggregateId: 'a-1', payload: 1 });
  });
});
