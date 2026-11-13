import type { EventBusEntry } from './event-bus-entry.type.js';
import type { SubscriberIdentity } from './subscriber.policy.js';

/**
 * One subscriber member's remaining work on one event, under isolation. `id` is the delivery's
 * own id (what `PgDeliveryQueue.replay` takes); `eventId` and `sequence` are the event's.
 */
export type DeliveryEntry = EventBusEntry & {
  readonly eventId: string;
  readonly consumerName: string;
  readonly handlerKey: string;
  readonly member: string;
  /** When the delivery was queued (or replayed); `maxAgeMs` counts from here. */
  readonly queuedAt: Date;
  /** A dead delivery that keeps its lane blocked. */
  readonly holdsLane: boolean;
};

/** A subscriber member's delivery created when an event settles. */
export type NewDelivery = {
  readonly handlerKey: string;
  readonly member: string;
  readonly status: 'PENDING' | 'FAILED';
  readonly retryCount: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly lastError?: string | undefined;
  readonly lastFailedBy?: string | undefined;
  /** Only for a FAILED delivery with an aggregate. */
  readonly holdsLane?: boolean | undefined;
};

export type DeliveryPair = {
  readonly key: string;
  readonly member: string;
  readonly eventType: string;
};

export type DeliveryLane = { readonly handlerKey: string; readonly aggregateId: string };

/** Moves queued work from an old identity to a new one (`previousKeys`). */
export type DeliveryMove = { readonly from: SubscriberIdentity; readonly to: SubscriberIdentity };

export type RekeyResult = {
  readonly moved: number;
  /** Rows whose event already had work under the new identity: dead-lettered, not held. */
  readonly superseded: number;
};

/** Work that hasn't drained, per subscriber member. */
export type DeliveryBacklog = {
  readonly handlerKey: string;
  readonly member: string;
  /** PENDING or CLAIMED deliveries. */
  readonly queued: number;
  /** Dead deliveries holding their lane. */
  readonly held: number;
  /** Lanes (aggregates) this work blocks. */
  readonly lanes: number;
};
