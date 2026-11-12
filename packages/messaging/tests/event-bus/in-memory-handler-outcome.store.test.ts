import { describe, expect, it } from 'vitest';
import { InMemoryHandlerOutcomeStore } from '../../src/event-bus/in-memory-handler-outcome.store.js';

describe('InMemoryHandlerOutcomeStore', () => {
  it('clears dead outcomes by default and done ones too with includeDone', async () => {
    const store = new InMemoryHandlerOutcomeStore();
    const both = [
      { key: 'a', outcome: 'done' as const },
      { key: 'b', outcome: 'dead' as const, error: 'bug' },
    ];
    await store.record('e1', both);
    await store.record('e2', both);

    await store.clear(['e1']);
    await store.clear(['e2', 'missing'], { includeDone: true });

    expect([...store.outcomesOf('e1').keys()]).toEqual(['a']);
    expect(store.outcomesOf('e2').size).toBe(0);
  });

  it('never lets a dead outcome replace a done one', async () => {
    const store = new InMemoryHandlerOutcomeStore();
    await store.record('e1', [{ key: 'b', outcome: 'done' }]);
    await store.record('e1', [{ key: 'b', outcome: 'dead', error: 'stale replica' }]);
    expect(store.outcomesOf('e1').get('b')).toEqual({ key: 'b', outcome: 'done' });
  });

  it('lets done replace dead', async () => {
    const store = new InMemoryHandlerOutcomeStore();
    await store.record('e1', [{ key: 'b', outcome: 'dead', error: 'bug' }]);
    await store.record('e1', [{ key: 'b', outcome: 'done' }]);
    expect(store.outcomesOf('e1').get('b')).toEqual({ key: 'b', outcome: 'done' });
  });
});
