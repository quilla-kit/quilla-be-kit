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

  it('produces a fresh executionAttemptId per call', () => {
    const a = executionContextFactory.createSystemContext('system');
    const b = executionContextFactory.createSystemContext('system');
    expect(a.executionAttemptId).toMatch(UUID);
    expect(a.executionAttemptId).not.toBe(b.executionAttemptId);
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

  it('produces a fresh executionAttemptId per call, uncontrollable by input', () => {
    const a = executionContextFactory.createBaselineContext({ correlationId: 'trace-abc' });
    const b = executionContextFactory.createBaselineContext({ correlationId: 'trace-abc' });
    expect(a.executionAttemptId).toMatch(UUID);
    expect(a.executionAttemptId).not.toBe(b.executionAttemptId);
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
    const ctx = executionContextFactory.createFromEventMetadata(meta);
    expect(ctx).toEqual({
      actorType: 'user',
      correlationId: 'corr-1',
      executionAttemptId: ctx.executionAttemptId,
      session: { scopeId: 'scope-1', userId: 'user-1' },
    });
    expect(ctx.executionAttemptId).toMatch(UUID);
  });

  it('produces a fresh executionAttemptId per call, not read from metadata', () => {
    const meta = EventMetadata.create({
      kind: EventKind.INTEGRATION,
      correlationId: 'corr-1',
      actorType: 'user',
    });
    const a = executionContextFactory.createFromEventMetadata(meta);
    const b = executionContextFactory.createFromEventMetadata(meta);
    expect(a.executionAttemptId).not.toBe(b.executionAttemptId);
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

describe('executionContextFactory.createFromEventMetadata with parsed JSON and attributes', () => {
  const roundTrip = (props: Parameters<typeof EventMetadata.create>[0]) =>
    JSON.parse(JSON.stringify(EventMetadata.create(props).toJSON()));

  it('reconstitutes a session-less context from JSON-shaped metadata with null ids', () => {
    const json = roundTrip({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'system',
    });
    const ctx = executionContextFactory.createFromEventMetadata(json);
    expect(ctx.session).toBeUndefined();
    expect(ctx.actorType).toBe('system');
  });

  it('round-trips actorAttributes through JSON onto the session', () => {
    const json = roundTrip({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'user',
      scopeId: 'scope-1',
      userId: 'user-1',
      actorAttributes: { projectId: 'p-1', quota: 3 },
    });
    const ctx = executionContextFactory.createFromEventMetadata(json);
    expect(ctx.session).toEqual({
      scopeId: 'scope-1',
      userId: 'user-1',
      projectId: 'p-1',
      quota: 3,
    });
  });

  it('never lets attributes override the base keys', () => {
    const ctx = executionContextFactory.createFromEventMetadata({
      actorType: 'user',
      correlationId: 'corr-1',
      scopeId: 'scope-1',
      userId: 'user-1',
      actorAttributes: { scopeId: 'forged', userId: 'forged', projectId: 'p-1' },
    });
    expect(ctx.session).toEqual({ scopeId: 'scope-1', userId: 'user-1', projectId: 'p-1' });
  });

  it('drops non-primitive attribute values arriving from JSON', () => {
    const ctx = executionContextFactory.createFromEventMetadata(
      JSON.parse(
        '{"actorType":"user","correlationId":"c","scopeId":"s","userId":"u","actorAttributes":{"projectId":"p-1","roles":["admin"],"nested":{"a":1},"none":null}}',
      ),
    );
    expect(ctx.session).toEqual({ scopeId: 's', userId: 'u', projectId: 'p-1' });
  });

  it('ignores a __proto__ attribute from JSON without touching the session prototype', () => {
    const ctx = executionContextFactory.createFromEventMetadata(
      JSON.parse(
        '{"actorType":"user","correlationId":"c","scopeId":"s","userId":"u","actorAttributes":{"__proto__":{"polluted":true},"projectId":"p-1"}}',
      ),
    );
    expect(ctx.session).toEqual({ scopeId: 's', userId: 'u', projectId: 'p-1' });
    expect(Object.getPrototypeOf(ctx.session)).toBe(Object.prototype);
    expect((ctx.session as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops attributes when the metadata has no session', () => {
    const ctx = executionContextFactory.createFromEventMetadata({
      actorType: 'job',
      correlationId: 'corr-1',
      scopeId: 'scope-1',
      userId: null,
      actorAttributes: { projectId: 'p-1' },
    });
    expect(ctx.session).toBeUndefined();
  });
});
