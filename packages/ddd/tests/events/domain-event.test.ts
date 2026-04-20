import { describe, expect, it } from 'vitest';
import { DomainEvent } from '../../src/events/domain-event.js';

class OrderPlaced extends DomainEvent<{ total: number }> {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('DomainEvent', () => {
  it('generates an id when none is provided', () => {
    expect(new OrderPlaced('agg-1', { total: 10 }).id).toMatch(UUID);
  });

  it('accepts an explicit id and occurredAt', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const evt = new OrderPlaced('agg-1', { total: 10 }, 'fixed-id', when);
    expect(evt.id).toBe('fixed-id');
    expect(evt.occurredAt).toBe(when);
  });

  it('exposes aggregateId and payload', () => {
    const evt = new OrderPlaced('agg-1', { total: 10 });
    expect(evt.aggregateId).toBe('agg-1');
    expect(evt.payload).toEqual({ total: 10 });
  });

  it('defaults name to the subclass constructor name', () => {
    expect(new OrderPlaced('agg-1', { total: 10 }).name).toBe('OrderPlaced');
  });

  it('produces a stable JSON shape', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const evt = new OrderPlaced('agg-1', { total: 10 }, 'fixed-id', when);
    expect(evt.toJSON()).toEqual({
      id: 'fixed-id',
      name: 'OrderPlaced',
      aggregateId: 'agg-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: { total: 10 },
    });
  });
});
