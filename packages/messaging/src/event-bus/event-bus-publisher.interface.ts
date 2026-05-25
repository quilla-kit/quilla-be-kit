export interface EventBusPublisher {
  publish(event: {
    readonly eventType: string;
    readonly eventVersion: number;
    readonly eventKind: string;
    readonly payload: unknown;
    readonly sourceService: string;
    readonly aggregateId?: string | undefined;
    readonly correlationId?: string | undefined;
    readonly createdAt: Date;
  }): Promise<string>;
}
