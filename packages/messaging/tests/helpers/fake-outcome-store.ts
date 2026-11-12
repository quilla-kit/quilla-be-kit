import type { HandlerOutcome } from '../../src/index.js';
import { InMemoryHandlerOutcomeStore } from '../../src/testing.js';

export class FakeOutcomeStore extends InMemoryHandlerOutcomeStore {
  readonly loads: (readonly string[])[] = [];
  readonly records: { eventId: string; outcomes: readonly HandlerOutcome[] }[] = [];
  loadError: Error | null = null;
  recordError: Error | null = null;

  override async load(
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly HandlerOutcome[]>> {
    this.loads.push([...eventIds]);
    if (this.loadError) throw this.loadError;
    return super.load(eventIds);
  }

  override async record(eventId: string, outcomes: readonly HandlerOutcome[]): Promise<void> {
    this.records.push({ eventId, outcomes });
    if (this.recordError) throw this.recordError;
    return super.record(eventId, outcomes);
  }
}
