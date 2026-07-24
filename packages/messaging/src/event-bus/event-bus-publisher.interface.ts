export interface EventBusPublisher {
  publish(event: {
    readonly eventType: string;
    readonly eventVersion: number;
    readonly eventKind: string;
    readonly payload: unknown;
    readonly sourceService: string;
    readonly occurredAt: Date;
    readonly aggregateId?: string | undefined;
    readonly correlationId?: string | undefined;
    readonly originEventId?: string | undefined;
    readonly createdAt: Date;
  }): Promise<{ readonly id: string; readonly inserted: boolean }>;
}
