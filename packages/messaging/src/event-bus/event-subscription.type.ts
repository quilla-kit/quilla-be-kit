import type { EventDescriptor } from './event.descriptor.js';

export type EventSubscription<TPayload = unknown> = {
  readonly descriptor: EventDescriptor<TPayload>;
  // Method syntax (not property form) so handlers remain bivariant in TPayload —
  // lets heterogeneous arrays like `EventSubscription[]` accept per-event specific types.
  handle(entry: {
    readonly payload: TPayload;
    readonly eventType: string;
    readonly eventVersion: number;
    readonly aggregateId?: string | undefined;
    readonly correlationId?: string | undefined;
  }): Promise<void>;
};
