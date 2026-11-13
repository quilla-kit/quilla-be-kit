import type { EventBusEntry, EventBusStatus } from '../event-bus/event-bus-entry.type.js';

export type EventsRow = {
  id: string;
  event_type: string;
  event_version: number;
  event_kind: string;
  payload: unknown;
  source_service: string;
  aggregate_id: string | null;
  correlation_id: string | null;
  origin_event_id: string | null;
  status: EventBusStatus;
  claimed_by: string | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
  failed_at: Date | null;
  last_failed_by: string | null;
  next_attempt_at: Date | null;
  seq: string | null;
  retry_count: number;
  last_error: string | null;
  created_at: Date;
  published_at: Date;
  occurred_at: Date;
};

export function toEventBusEntry(row: Omit<EventsRow, 'origin_event_id'>): EventBusEntry {
  return {
    id: row.id,
    eventType: row.event_type,
    eventVersion: row.event_version,
    eventKind: row.event_kind,
    payload: row.payload,
    sourceService: row.source_service,
    occurredAt: row.occurred_at,
    ...(row.aggregate_id !== null ? { aggregateId: row.aggregate_id } : {}),
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    status: row.status,
    ...(row.claimed_by !== null ? { claimedBy: row.claimed_by } : {}),
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.lease_expires_at !== null ? { leaseExpiresAt: row.lease_expires_at } : {}),
    retryCount: row.retry_count,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.failed_at !== null ? { failedAt: row.failed_at } : {}),
    ...(row.last_failed_by !== null ? { lastFailedBy: row.last_failed_by } : {}),
    ...(row.next_attempt_at !== null ? { nextAttemptAt: row.next_attempt_at } : {}),
    createdAt: row.created_at,
    publishedAt: row.published_at,
  };
}
