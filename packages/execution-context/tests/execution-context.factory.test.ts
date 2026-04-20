import { EventKind, EventMetadata } from '@quilla-kit/ddd';
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

  it('omits scopeId and userId', () => {
    const ctx = executionContextFactory.createSystemContext('system');
    expect(ctx.scopeId).toBeUndefined();
    expect(ctx.userId).toBeUndefined();
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
  it('copies actorType, correlationId, scopeId, and userId when present', () => {
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
      scopeId: 'scope-1',
      userId: 'user-1',
    });
  });

  it('omits scopeId and userId when absent on metadata', () => {
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'system',
    });
    const ctx = executionContextFactory.createFromEventMetadata(meta);
    expect(ctx.scopeId).toBeUndefined();
    expect(ctx.userId).toBeUndefined();
    expect(ctx.actorType).toBe('system');
    expect(ctx.correlationId).toBe('corr-1');
  });
});
