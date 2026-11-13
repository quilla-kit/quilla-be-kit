import type { DeliveryBacklog } from './delivery-entry.type.js';

/** What `EventConsumer.prepare()` found and did before any dispatch. */
export type PrepareResult = {
  /** Deliveries moved to their subscriber's current identity (`previousKeys`). */
  readonly moved: number;
  /** Deliveries dead-lettered by those moves, because the target already had the work. */
  readonly superseded: number;
  /** Work of members this consumer doesn't register; with `lanes > 0` it blocks those lanes. */
  readonly unregistered: readonly DeliveryBacklog[];
  /** Holds kept by subscribers that no longer hold (or with isolation off). */
  readonly staleHolds: readonly DeliveryBacklog[];
};
