import { EventKind, EventMetadata } from '@quilla-be-kit/ddd';
import { describe, expect, it } from 'vitest';
import { executionContextFactory } from '../src/execution-context.factory.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('executionContextFactory.createSystemContext', () => {
  it('produces a fresh correlationId per call', () => {
    const a = executionContextFactory.createSystemContext('system');
    const b = executionContextFactory.createSystemContext('system');
    expect(a.correlationId).toMatch(UUID);
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it('sets actorType to the requested value', () => {
    expect(executionContextFactory.createSystemContext('system').actorType).toBe('system');
    expect(executionContextFactory.createSystemContext('job').actorType).toBe('job');
  });

  it('omits session — system contexts are never authenticated', () => {
    const ctx = executionContextFactory.createSystemContext('system');
    expect(ctx.session).toBeUndefined();
  });
});

describe('executionContextFactory.createBaselineContext', () => {
  it('defaults actorType to anonymous with a fresh correlationId', () => {
    const ctx = executionContextFactory.createBaselineContext();
    expect(ctx.actorType).toBe('anonymous');
    expect(ctx.correlationId).toMatch(UUID);
  });

  it('uses the provided correlationId when given', () => {
    const ctx = executionContextFactory.createBaselineContext({ correlationId: 'trace-abc' });
    expect(ctx.correlationId).toBe('trace-abc');
  });

  it('generates a correlationId when an empty input is passed', () => {
    const ctx = executionContextFactory.createBaselineContext({});
    expect(ctx.correlationId).toMatch(UUID);
  });
});

describe('executionContextFactory.createFromEventMetadata', () => {
  it('reconstructs a session when both scopeId and userId are present', () => {
    const meta = EventMetadata.create({
      kind: EventKind.INTEGRATION,
      correlationId: 'corr-1',
      actorType: 'user',
      scopeId: 'scope-1',
      userId: 'user-1',
    });
    expect(executionContextFactory.createFromEventMetadata(meta)).toEqual({
      actorType: 'user',
      correlationId: 'corr-1',
      session: { scopeId: 'scope-1', userId: 'user-1' },
    });
  });

  it('omits session when metadata has neither scopeId nor userId', () => {
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'system',
    });
    const ctx = executionContextFactory.createFromEventMetadata(meta);
    expect(ctx.session).toBeUndefined();
    expect(ctx.actorType).toBe('system');
    expect(ctx.correlationId).toBe('corr-1');
  });

  it('omits session when metadata has only one of scopeId / userId', () => {
    // Half-populated metadata comes from non-auth contexts (e.g. system
    // job scoped to a tenant without a user). Session is all-or-nothing.
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'job',
      scopeId: 'scope-1',
    });
    const ctx = executionContextFactory.createFromEventMetadata(meta);
    expect(ctx.session).toBeUndefined();
  });
});
