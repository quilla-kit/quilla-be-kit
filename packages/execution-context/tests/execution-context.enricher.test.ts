import { describe, expect, it } from 'vitest';
import { AsyncExecutionContextProvider } from '../src/async-execution-context.provider.js';
import { ExecutionContextEnricher } from '../src/execution-context.enricher.js';

describe('ExecutionContextEnricher', () => {
  it('contributes all context fields when provider has an active scope', async () => {
    const provider = new AsyncExecutionContextProvider();
    const enricher = new ExecutionContextEnricher(provider);

    await provider.runWithContext(
      { actorType: 'user', correlationId: 'corr-1', scopeId: 'scope-1', userId: 'user-1' },
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

  it('omits absent scopeId and userId', async () => {
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
