import type { EventBusEntry } from './event-bus-entry.type.js';

/**
 * One subscriber's remaining work on one event, under isolation. `id` is the delivery's own id
 * (what `PgDeliveryQueue.replay` takes); `eventId` is the event's.
 */
export type DeliveryEntry = EventBusEntry & {
  readonly eventId: string;
  readonly consumerName: string;
  readonly handlerKey: string;
  /** When the delivery was queued (or replayed); `maxAgeMs` counts from here. */
  readonly queuedAt: Date;
};

/** A subscriber's delivery created when an event settles. */
export type NewDelivery = {
  readonly handlerKey: string;
  readonly status: 'PENDING' | 'FAILED';
  readonly retryCount: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly lastError?: string | undefined;
  readonly lastFailedBy?: string | undefined;
};

export type DeliveryPair = { readonly key: string; readonly eventType: string };

export type DeliveryLane = { readonly handlerKey: string; readonly aggregateId: string };
