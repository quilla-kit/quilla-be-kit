import { describe, expect, it } from 'vitest';
import { IntegrationEvent } from '../../src/events/integration-event.js';

class UserAuthenticated extends IntegrationEvent<{ userId: string }> {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('IntegrationEvent', () => {
  it('generates an id and occurredAt by default', () => {
    const evt = new UserAuthenticated({ userId: 'u-1' });
    expect(evt.id).toMatch(UUID);
    expect(evt.occurredAt).toBeInstanceOf(Date);
  });

  it('accepts explicit id and occurredAt', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const evt = new UserAuthenticated({ userId: 'u-1' }, 'fixed-id', when);
    expect(evt.id).toBe('fixed-id');
    expect(evt.occurredAt).toBe(when);
  });

  it('defaults name to the subclass constructor name', () => {
    expect(new UserAuthenticated({ userId: 'u-1' }).name).toBe('UserAuthenticated');
  });

  it('produces a stable JSON shape', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const evt = new UserAuthenticated({ userId: 'u-1' }, 'fixed-id', when);
    expect(evt.toJSON()).toEqual({
      id: 'fixed-id',
      name: 'UserAuthenticated',
      occurredAt: '2026-01-01T00:00:00.000Z',
      payload: { userId: 'u-1' },
    });
  });
});
