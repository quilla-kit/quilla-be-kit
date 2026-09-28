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

describe('EventMetadata actorAttributes', () => {
  const when = new Date('2026-01-01T00:00:00.000Z');
  const base = {
    kind: EventKind.DOMAIN,
    correlationId: 'corr-1',
    actorType: 'user',
    scopeId: 'scope-1',
    userId: 'user-1',
    createdAt: when,
  } as const;

  it('omits the key from JSON when absent, keeping the wire shape unchanged', () => {
    const json = EventMetadata.create(base).toJSON();
    expect(Object.keys(json)).toEqual([
      'kind',
      'correlationId',
      'actorType',
      'scopeId',
      'userId',
      'createdAt',
    ]);
  });

  it('carries and serializes attributes when set', () => {
    const meta = EventMetadata.create({ ...base, actorAttributes: { projectId: 'p-1' } });
    expect(meta.actorAttributes).toEqual({ projectId: 'p-1' });
    expect(meta.toJSON().actorAttributes).toEqual({ projectId: 'p-1' });
  });

  it('snapshots attributes so later mutation of the input has no effect', () => {
    const input: Record<string, string> = { projectId: 'p-1' };
    const meta = EventMetadata.create({ ...base, actorAttributes: input });
    input.projectId = 'changed';
    expect(meta.actorAttributes).toEqual({ projectId: 'p-1' });
  });

  it('rejects attributes without both scopeId and userId', () => {
    expect(() =>
      EventMetadata.create({
        kind: EventKind.DOMAIN,
        correlationId: 'corr-1',
        actorType: 'job',
        scopeId: 'scope-1',
        actorAttributes: { projectId: 'p-1' },
      }),
    ).toThrow(/require both scopeId and userId/);
  });

  it.each(['scopeId', 'userId', 'constructor', 'prototype'])(
    'rejects the reserved attribute key %s',
    (key) => {
      expect(() => EventMetadata.create({ ...base, actorAttributes: { [key]: 'x' } })).toThrow(
        /reserved actorAttributes key/,
      );
    },
  );
});
