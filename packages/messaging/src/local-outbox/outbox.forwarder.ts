import { randomUUID } from 'node:crypto';
import type { Logger } from '@quilla-be-kit/observability';
import type { Disposable } from '@quilla-be-kit/runtime';
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
  readonly instanceId?: string;
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
      },
    });
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

      this.logger.debug(`forwarding ${entries.length} event(s)`);

      for (const entry of entries) {
        if (this.stopping) break;
        try {
          const busEventId = await this.publisher.publish({
            eventType: entry.eventType,
            eventVersion: entry.eventVersion,
            eventKind: entry.eventKind,
            payload: entry.payload,
            sourceService: this.sourceService,
            ...(entry.aggregateId !== undefined ? { aggregateId: entry.aggregateId } : {}),
            ...(entry.correlationId !== undefined ? { correlationId: entry.correlationId } : {}),
            createdAt: entry.createdAt,
          });
          this.logger.debug('forwarded outbox entry', {
            meta: { outboxId: entry.id, busEventId, eventType: entry.eventType },
          });
          await this.reader.markSent(entry.id, new Date());
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.error(`failed to forward event ${entry.id}`, err, {
            meta: { outboxId: entry.id, eventType: entry.eventType },
          });
          await this.reader.markFailed(entry.id, reason);
        }
      }
    } catch (err) {
      this.logger.error('tick error', err);
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
