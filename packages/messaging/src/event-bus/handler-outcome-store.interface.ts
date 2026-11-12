export type HandlerOutcome = {
  readonly key: string;
  readonly outcome: 'done' | 'dead';
  // The permanent failure's message, for 'dead'.
  readonly error?: string | undefined;
};

export type ClearHandlerOutcomesOptions = {
  /** Also clear 'done', so every handler runs again. Default: only 'dead' is cleared. */
  readonly includeDone?: boolean;
};

/**
 * Outcomes of the handlers of one bus row, so a redelivery runs only the handlers that haven't
 * finished: 'done' and 'dead' handlers are skipped until their outcome is cleared. A store must
 * drop the outcomes of events the bus deleted (eventually, e.g. by a cascade or a TTL).
 */
export interface HandlerOutcomeStore {
  /** Event ids with no outcomes are absent from the map. */
  load(eventIds: readonly string[]): Promise<ReadonlyMap<string, readonly HandlerOutcome[]>>;
  /**
   * Upserts by `(eventId, key)`. 'done' is final: a later 'dead' for the same key never
   * replaces it (a replica that lost its claim may write late). Must not fail when the event
   * no longer exists.
   */
  record(eventId: string, outcomes: readonly HandlerOutcome[]): Promise<void>;
  /** Run before an event is replayed, so its cleared handlers run again. */
  clear(eventIds: readonly string[], options?: ClearHandlerOutcomesOptions): Promise<void>;
}
