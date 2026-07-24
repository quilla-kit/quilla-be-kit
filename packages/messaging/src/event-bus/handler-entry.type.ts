export type HandlerEntry<TPayload = unknown> = {
  readonly id: string;
  readonly payload: TPayload;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly occurredAt: Date;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
};
