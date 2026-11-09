import { EventKind, EventMetadata } from '@quilla-be-kit/ddd';
import { describe, expect, it } from 'vitest';
import { executionContextFactory } from '../src/execution-context.factory.js';
import type { ExecutionContext } from '../src/execution-context.type.js';
import { toEventMetadataSource } from '../src/to-event-metadata-source.js';

const base = { actorType: 'user', correlationId: 'corr-1', executionAttemptId: 'a-1' } as const;

function roundTrip(ctx: ExecutionContext, actorAttributeKeys?: readonly string[]) {
  const source = toEventMetadataSource(ctx, actorAttributeKeys ? { actorAttributeKeys } : {});
  const meta = EventMetadata.create({ kind: EventKind.DOMAIN, ...source });
  const parsed = JSON.parse(JSON.stringify(meta.toJSON()));
  const { executionAttemptId: _attempt, ...rebuilt } =
    executionContextFactory.createFromEventMetadata(parsed);
  return rebuilt;
}

describe('toEventMetadataSource round trip', () => {
  it.each<[string, ExecutionContext]>([
    ['authenticated', { ...base, session: { scopeId: 's-1', userId: 'u-1' } }],
    ['session-less scoped', { ...base, actorType: 'job', scopeId: 's-1' }],
    ['unscoped', { ...base, actorType: 'system' }],
    [
      'crossed',
      { ...base, session: { scopeId: 'tenant-1', userId: 'u-1' }, crossedFrom: 'platform' },
    ],
    ['crossed session-less', { ...base, actorType: 'job', scopeId: 's-2', crossedFrom: 's-1' }],
  ])('rebuilds the %s context', (_label, ctx) => {
    const { executionAttemptId: _attempt, ...expected } = ctx;
    expect(roundTrip(ctx)).toEqual(expected);
  });

  it('carries the listed primitive session fields as actor attributes', () => {
    const ctx = {
      ...base,
      session: { scopeId: 's-1', userId: 'u-1', projectId: 'p-1', roles: ['x'], level: 3 },
    } as ExecutionContext;
    expect(roundTrip(ctx, ['projectId', 'roles', 'level', 'missing']).session).toEqual({
      scopeId: 's-1',
      userId: 'u-1',
      projectId: 'p-1',
      level: 3,
    });
  });

  it('never picks reserved keys', () => {
    const ctx = { ...base, session: { scopeId: 's-1', userId: 'u-1' } };
    const source = toEventMetadataSource(ctx, {
      actorAttributeKeys: ['scopeId', 'userId', 'constructor', '__proto__'],
    });
    expect(source).not.toHaveProperty('actorAttributes');
  });

  it('drops a stale crossedFrom that equals the scope or has no scope', () => {
    expect(
      toEventMetadataSource({ ...base, scopeId: 's-1', crossedFrom: 's-1' }),
    ).not.toHaveProperty('crossedFrom');
    expect(toEventMetadataSource({ ...base, crossedFrom: 's-1' })).not.toHaveProperty(
      'crossedFrom',
    );
  });

  it('takes userId from the session only', () => {
    expect(toEventMetadataSource({ ...base, scopeId: 's-1' })).not.toHaveProperty('userId');
  });
});

describe('createFromEventMetadata crossedFrom', () => {
  it('ignores a crossedFrom without a scope or equal to it', () => {
    const meta = { actorType: 'user', correlationId: 'c', scopeId: null, crossedFrom: 'x' };
    expect(executionContextFactory.createFromEventMetadata(meta)).not.toHaveProperty('crossedFrom');
    expect(
      executionContextFactory.createFromEventMetadata({ ...meta, scopeId: 'x' }),
    ).not.toHaveProperty('crossedFrom');
  });
});
