import { randomUUID } from 'node:crypto';

export type IntegrationEventJSON = {
  readonly id: string;
  readonly name: string;
  readonly occurredAt: string;
  readonly payload: unknown;
};

export abstract class IntegrationEvent<TPayload = unknown> {
  readonly id: string;
  readonly occurredAt: Date;
  readonly payload: TPayload;

  constructor(payload: TPayload, id?: string, occurredAt?: Date) {
    this.id = id ?? randomUUID();
    this.occurredAt = occurredAt ?? new Date();
    this.payload = payload;
  }

  /** The wire name for this event. Defaults to the subclass constructor name; override to customize. */
  get name(): string {
    return this.constructor.name;
  }

  toJSON(): IntegrationEventJSON {
    return {
      id: this.id,
      name: this.name,
      occurredAt: this.occurredAt.toISOString(),
      payload: this.payload,
    };
  }
}
