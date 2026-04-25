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
        session: { scopeId: 'scope-1', userId: 'user-1' },
      },
      async () => {
        expect(enricher.enrich()).toEqual({
          context: {
            scopeId: 'scope-1',
            userId: 'user-1',
            actorType: 'user',
            correlationId: 'corr-1',
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

    await provider.runWithContext({ actorType: 'system', correlationId: 'corr-1' }, async () => {
      expect(enricher.enrich()).toEqual({
        context: {
          actorType: 'system',
          correlationId: 'corr-1',
        },
      });
    });
  });

  it('returns an empty contribution when provider is outside a scope', () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);
    expect(enricher.enrich()).toEqual({});
  });
});
