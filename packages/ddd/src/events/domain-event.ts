import { randomUUID } from 'node:crypto';

export type DomainEventJSON = {
  readonly id: string;
  readonly name: string;
  readonly aggregateId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
};

export abstract class DomainEvent<TPayload = unknown> {
  readonly id: string;
  readonly occurredAt: Date;
  readonly aggregateId: string;
  readonly payload: TPayload;

  constructor(aggregateId: string, payload: TPayload, id?: string, occurredAt?: Date) {
    this.id = id ?? randomUUID();
    this.aggregateId = aggregateId;
    this.payload = payload;
    this.occurredAt = occurredAt ?? new Date();
  }

  /** The wire name for this event. Defaults to the subclass constructor name; override to customize. */
  get name(): string {
    return this.constructor.name;
  }

  toJSON(): DomainEventJSON {
    return {
      id: this.id,
      name: this.name,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt.toISOString(),
      payload: this.payload,
    };
  }
}
