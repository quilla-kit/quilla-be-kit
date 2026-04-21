export type LocalOutboxStatus = 'PENDING' | 'CLAIMED' | 'SENT' | 'FAILED';

export type LocalOutboxEntry = {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly eventKind: string;
  readonly payload: unknown;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly status: LocalOutboxStatus;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: Date | undefined;
  readonly retryCount: number;
  readonly lastError?: string | undefined;
  readonly publishedAt?: Date | undefined;
  readonly createdAt: Date;
};

export type LocalOutboxInsertInput = {
  readonly id?: string;
  readonly eventType: string;
  readonly eventVersion?: number;
  readonly eventKind: string;
  readonly payload: unknown;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly createdAt?: Date;
};
