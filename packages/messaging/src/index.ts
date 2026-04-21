// event bus
export type { EventBusEntry, EventBusStatus } from './event-bus/event-bus-entry.type.js';
export type { EventBusPublisher } from './event-bus/event-bus-publisher.interface.js';
export type { EventBusConsumer } from './event-bus/event-bus-consumer.interface.js';
export {
  EventConsumer,
  type EventConsumerOptions,
  type EventHandler,
} from './event-bus/event.consumer.js';
export { defineEvent, type EventDescriptor } from './event-bus/event.descriptor.js';
export {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
} from './event-bus/defaults.js';

// local outbox
export type {
  LocalOutboxEntry,
  LocalOutboxInsertInput,
  LocalOutboxStatus,
} from './local-outbox/local-outbox-entry.type.js';
export type { LocalOutboxReader } from './local-outbox/local-outbox-reader.interface.js';
export type { LocalOutboxWriter } from './local-outbox/local-outbox-writer.interface.js';
export type { TransactionHandle } from './local-outbox/transaction-handle.interface.js';
export { OutboxForwarder, type OutboxForwarderOptions } from './local-outbox/outbox.forwarder.js';
