export type EventBusStatus = 'PENDING' | 'CLAIMED' | 'FAILED';

export type EventBusEntry = {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly eventKind: string;
  readonly payload: unknown;
  readonly sourceService: string;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly status: EventBusStatus;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: Date | undefined;
  readonly retryCount: number;
  readonly lastError?: string | undefined;
  readonly createdAt: Date;
  readonly publishedAt: Date;
};
