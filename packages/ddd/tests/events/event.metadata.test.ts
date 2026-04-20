import { describe, expect, it } from 'vitest';
import { EventKind, EventMetadata } from '../../src/events/event.metadata.js';

describe('EventMetadata', () => {
  it('captures the required fields', () => {
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'user',
    });
    expect(meta.kind).toBe(EventKind.DOMAIN);
    expect(meta.correlationId).toBe('corr-1');
    expect(meta.actorType).toBe('user');
  });

  it('leaves scopeId and userId undefined when absent', () => {
    const meta = EventMetadata.create({
      kind: EventKind.INTEGRATION,
      correlationId: 'corr-1',
      actorType: 'system',
    });
    expect(meta.scopeId).toBeUndefined();
    expect(meta.userId).toBeUndefined();
  });

  it('defaults createdAt to now', () => {
    const before = Date.now();
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'user',
    });
    const after = Date.now();
    expect(meta.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(meta.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('serializes absent scopeId and userId as null', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'user',
      createdAt: when,
    });
    expect(meta.toJSON()).toEqual({
      kind: 'domain',
      correlationId: 'corr-1',
      actorType: 'user',
      scopeId: null,
      userId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('serializes provided scopeId and userId', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    const meta = EventMetadata.create({
      kind: EventKind.INTEGRATION,
      correlationId: 'corr-1',
      actorType: 'user',
      scopeId: 'workspace-1',
      userId: 'user-1',
      createdAt: when,
    });
    const json = meta.toJSON();
    expect(json.scopeId).toBe('workspace-1');
    expect(json.userId).toBe('user-1');
  });

  it('accepts extended ActorType strings via the escape hatch', () => {
    const meta = EventMetadata.create({
      kind: EventKind.INTEGRATION,
      correlationId: 'corr-1',
      actorType: 'webhook',
    });
    expect(meta.actorType).toBe('webhook');
  });
});
