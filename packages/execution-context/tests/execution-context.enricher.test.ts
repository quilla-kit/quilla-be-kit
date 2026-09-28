import { describe, expect, it } from 'vitest';
import { AsyncExecutionContextProvider } from '../src/async-execution-context.provider.js';
import { ExecutionContextEnricher } from '../src/execution-context.enricher.js';

describe('ExecutionContextEnricher', () => {
  it('contributes all context fields when provider has an active scope', async () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);

    await provider.runWithContext(
      {
        actorType: 'user',
        correlationId: 'corr-1',
        executionAttemptId: 'attempt-1',
        session: { scopeId: 'scope-1', userId: 'user-1' },
      },
      async () => {
        expect(enricher.enrich()).toEqual({
          context: {
            scopeId: 'scope-1',
            userId: 'user-1',
            actorType: 'user',
            correlationId: 'corr-1',
            executionAttemptId: 'attempt-1',
          },
        });
      },
    );
  });

  it('flattens session into top-level scopeId / userId log fields', async () => {
    // Log output stays flat even though the context groups — dashboards and
    // log queries keep their field names.
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);
    await provider.runWithContext(
      {
        actorType: 'user',
        correlationId: 'corr-1',
        executionAttemptId: 'attempt-1',
        session: { scopeId: 'scope-1', userId: 'user-1' },
      },
      async () => {
        const contribution = enricher.enrich();
        expect(contribution.context).not.toHaveProperty('session');
        expect(contribution.context).toMatchObject({ scopeId: 'scope-1', userId: 'user-1' });
      },
    );
  });

  it('omits scopeId / userId when there is no session', async () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);

    await provider.runWithContext(
      { actorType: 'system', correlationId: 'corr-1', executionAttemptId: 'attempt-1' },
      async () => {
        expect(enricher.enrich()).toEqual({
          context: {
            actorType: 'system',
            correlationId: 'corr-1',
            executionAttemptId: 'attempt-1',
          },
        });
      },
    );
  });

  it('returns an empty contribution when provider is outside a scope', () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);
    expect(enricher.enrich()).toEqual({});
  });
});

describe('ExecutionContextEnricher sessionKeys', () => {
  const ctx = {
    actorType: 'user',
    correlationId: 'corr-1',
    executionAttemptId: 'attempt-1',
    session: { scopeId: 'scope-1', userId: 'user-1', projectId: 'p-1', authMethod: 'api-key' },
  } as const;

  it('logs listed session fields under extra.session, leaving the typed context unchanged', async () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider, {
      sessionKeys: ['projectId', 'authMethod', 'missing', 'scopeId'],
    });
    await provider.runWithContext(ctx, async () => {
      expect(enricher.enrich()).toEqual({
        context: {
          scopeId: 'scope-1',
          userId: 'user-1',
          actorType: 'user',
          correlationId: 'corr-1',
          executionAttemptId: 'attempt-1',
        },
        extra: { session: { projectId: 'p-1', authMethod: 'api-key' } },
      });
    });
  });

  it.each([
    ['only inherited properties are listed', { sessionKeys: ['constructor', 'toString'] }],
    ['none of the listed keys are present', { sessionKeys: ['missing'] }],
    ['the option is omitted (unchanged output)', undefined],
  ])('adds no extra when %s', async (_label, options) => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider, options);
    await provider.runWithContext(ctx, async () => {
      expect(enricher.enrich()).not.toHaveProperty('extra');
    });
  });
});
