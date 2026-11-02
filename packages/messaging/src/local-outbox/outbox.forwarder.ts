import { randomUUID } from 'node:crypto';
import type { Logger } from '@quilla-be-kit/observability';
import type { Disposable } from '@quilla-be-kit/runtime';
import { ClaimLeaseManager } from '../event-bus/claim-lease.manager.js';
import type { LeaseLostInfo } from '../event-bus/claim-lease.type.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_STALE_CLAIM_MS,
} from '../event-bus/defaults.js';
import type { EventBusPublisher } from '../event-bus/event-bus-publisher.interface.js';
import type { LocalOutboxReader } from './local-outbox-reader.interface.js';

export type OutboxForwarderOptions = {
  readonly reader: LocalOutboxReader;
  readonly publisher: EventBusPublisher;
  readonly sourceService: string;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly staleClaimAfterMs?: number;
  readonly renewIntervalMs?: number;
  readonly instanceId?: string;
  readonly onLeaseLost?: (info: LeaseLostInfo) => void;
};

export class OutboxForwarder implements Disposable {
  readonly name = 'OutboxForwarder';
  private readonly reader: LocalOutboxReader;
  private readonly publisher: EventBusPublisher;
  private readonly sourceService: string;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly staleClaimAfterMs: number;
  private readonly instanceId: string;
  private readonly leases: ClaimLeaseManager;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopping = false;

  constructor(options: OutboxForwarderOptions) {
    this.reader = options.reader;
    this.publisher = options.publisher;
    this.sourceService = options.sourceService;
    this.logger = options.logger;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.staleClaimAfterMs = options.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_MS;
    this.instanceId = options.instanceId ?? randomUUID();
    this.leases = new ClaimLeaseManager({
      lease: options.reader.lease,
      instanceId: this.instanceId,
      renewIntervalMs: options.renewIntervalMs,
      logger: this.logger,
      onLeaseLost: options.onLeaseLost,
    });
  }

  start(): void {
    if (this.intervalHandle) return;
    this.stopping = false;
    this.logger.info('starting', {
      meta: {
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
        sourceService: this.sourceService,
        instanceId: this.instanceId,
        leaseMs: this.leases.leaseMs,
        renewIntervalMs: this.leases.renewIntervalMs,
      },
    });
    this.leases.warnIfDisabled();
    this.intervalHandle = setInterval(() => {
      if (this.stopping || this.inflightTick) return;
      this.inflightTick = this.tick().finally(() => {
        this.inflightTick = null;
      });
    }, this.pollIntervalMs);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.inflightTick) {
      await this.inflightTick.catch(() => {});
    }
    this.logger.info('stopped');
  }

  private async tick(): Promise<void> {
    try {
      await this.sweepStale();
      const entries = await this.reader.claim(this.instanceId, this.batchSize);
      if (entries.length === 0) return;
      this.leases.begin(entries);

      this.logger.debug(`forwarding ${entries.length} event(s)`);

      for (const entry of entries) {
        if (this.stopping) break;
        if (!(await this.leases.acquire(entry))) continue;
        this.leases.hold(entry);
        try {
          const { id: busEventId, inserted } = await this.publisher.publish({
            eventType: entry.eventType,
            eventVersion: entry.eventVersion,
            eventKind: entry.eventKind,
            payload: entry.payload,
            sourceService: this.sourceService,
            occurredAt: entry.occurredAt,
            ...(entry.aggregateId !== undefined ? { aggregateId: entry.aggregateId } : {}),
            ...(entry.correlationId !== undefined ? { correlationId: entry.correlationId } : {}),
            originEventId: entry.id,
            createdAt: entry.createdAt,
          });
          this.logger.debug(
            inserted ? 'forwarded outbox entry' : 'outbox entry already on bus (dedup hit)',
            {
              meta: { outboxId: entry.id, busEventId, eventType: entry.eventType, inserted },
            },
          );
          await this.leases.settle(entry, 'done', () =>
            this.reader.markSent(entry.id, new Date(), this.instanceId),
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`failed to forward event ${entry.id}`, err, {
            meta: { outboxId: entry.id, eventType: entry.eventType },
          });
          await this.leases.settle(entry, 'failed', () =>
            this.reader.markFailed(entry.id, reason, this.instanceId),
          );
        }
      }
    } catch (err) {
      this.logger.error('tick error', err);
    } finally {
      this.leases.end();
    }
  }

  private async sweepStale(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.staleClaimAfterMs);
      const reset = await this.reader.resetStale(cutoff);
      if (reset > 0) {
        this.logger.warn(`reset ${reset} stale CLAIMED row(s)`, {
          meta: { cutoff: cutoff.toISOString() },
        });
      }
    } catch (err) {
      this.logger.error('stale sweep failed', err);
    }
  }
}
