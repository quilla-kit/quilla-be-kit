export type EventBusStatus = 'PENDING' | 'CLAIMED' | 'FAILED';

export type EventBusEntry = {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly eventKind: string;
  readonly payload: unknown;
  readonly sourceService: string;
  readonly occurredAt: Date;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
  /**
   * The bus's publish-order sequence (a decimal BIGINT; compare with `BigInt()`). It increases
   * in publish order within one bus, with gaps; absent for rows written before 0.9.0.
   */
  readonly sequence?: string | undefined;
  readonly status: EventBusStatus;
  readonly claimedBy?: string | undefined;
  readonly claimedAt?: Date | undefined;
  readonly leaseExpiresAt?: Date | undefined;
  readonly retryCount: number;
  readonly lastError?: string | undefined;
  readonly failedAt?: Date | undefined;
  // The instance whose attempt failed last.
  readonly lastFailedBy?: string | undefined;
  // When a retry is due (other instances); the instance that failed it waits a failover window more.
  readonly nextAttemptAt?: Date | undefined;
  readonly createdAt: Date;
  readonly publishedAt: Date;
};
