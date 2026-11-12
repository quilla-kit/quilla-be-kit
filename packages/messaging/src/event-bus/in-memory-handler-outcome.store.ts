import type {
  ClearHandlerOutcomesOptions,
  HandlerOutcome,
  HandlerOutcomeStore,
} from './handler-outcome-store.interface.js';

export class InMemoryHandlerOutcomeStore implements HandlerOutcomeStore {
  private readonly byEvent = new Map<string, Map<string, HandlerOutcome>>();

  async load(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly HandlerOutcome[]>> {
    const result = new Map<string, readonly HandlerOutcome[]>();
    for (const id of eventIds) {
      const outcomes = this.byEvent.get(id);
      if (outcomes && outcomes.size > 0) result.set(id, [...outcomes.values()]);
    }
    return result;
  }

  async record(eventId: string, outcomes: readonly HandlerOutcome[]): Promise<void> {
    const current = this.byEvent.get(eventId) ?? new Map<string, HandlerOutcome>();
    for (const outcome of outcomes) {
      if (current.get(outcome.key)?.outcome === 'done') continue;
      current.set(outcome.key, { ...outcome });
    }
    this.byEvent.set(eventId, current);
  }

  async clear(eventIds: readonly string[], options?: ClearHandlerOutcomesOptions): Promise<void> {
    for (const id of eventIds) {
      const outcomes = this.byEvent.get(id);
      if (!outcomes) continue;
      for (const [key, outcome] of outcomes) {
        if (options?.includeDone || outcome.outcome === 'dead') outcomes.delete(key);
      }
    }
  }

  /** Every outcome recorded for `eventId`, keyed by handler key. */
  outcomesOf(eventId: string): ReadonlyMap<string, HandlerOutcome> {
    return new Map(this.byEvent.get(eventId));
  }
}
