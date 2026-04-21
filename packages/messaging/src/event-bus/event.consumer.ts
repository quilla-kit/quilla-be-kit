import { randomUUID } from 'node:crypto';
import type {
  ExecutionContext,
  ExecutionContextFactory,
  ExecutionContextProvider,
} from '@quilla-kit/execution-context';
import type { Disposable } from '@quilla-kit/lifecycle';
import type { Logger } from '@quilla-kit/observability';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_STALE_CLAIM_MS,
} from './defaults.js';
import type { EventBusConsumer } from './event-bus-consumer.interface.js';
import type { EventBusEntry } from './event-bus-entry.type.js';
import type { EventDescriptor } from './event.descriptor.js';

export type EventHandler<TPayload = unknown> = (entry: {
  readonly payload: TPayload;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly aggregateId?: string | undefined;
  readonly correlationId?: string | undefined;
}) => Promise<void>;

export type EventConsumerOptions = {
  readonly bus: EventBusConsumer;
  readonly consumerName: string;
  readonly sourceService: string;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly skipOwnEventKinds?: readonly string[];
  readonly staleClaimAfterMs?: number;
  readonly instanceId?: string;
  readonly executionContext?: {
    readonly factory: ExecutionContextFactory;
    readonly provider: ExecutionContextProvider;
  };
  readonly onProcessed?: (entry: EventBusEntry) => void;
};

export class EventConsumer implements Disposable {
  private readonly bus: EventBusConsumer;
  private readonly consumerName: string;
  private readonly sourceService: string;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly skipOwnEventKinds: ReadonlySet<string>;
  private readonly staleClaimAfterMs: number;
  private readonly instanceId: string;
  private readonly executionContext: EventConsumerOptions['executionContext'];
  private readonly onProcessed: ((entry: EventBusEntry) => void) | undefined;
  private readonly handlers = new Map<string, EventHandler[]>();

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopping = false;

  constructor(options: EventConsumerOptions) {
    this.bus = options.bus;
    this.consumerName = options.consumerName;
    this.sourceService = options.sourceService;
    this.logger = options.logger.forMethod(`EventConsumer:${options.consumerName}`);
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.skipOwnEventKinds = new Set(options.skipOwnEventKinds ?? []);
    this.staleClaimAfterMs = options.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_MS;
    this.instanceId = options.instanceId ?? randomUUID();
    this.executionContext = options.executionContext;
    this.onProcessed = options.onProcessed;
  }

  get name(): string {
    return `EventConsumer:${this.consumerName}`;
  }

  on<TPayload>(descriptor: EventDescriptor<TPayload>, handler: EventHandler<TPayload>): this;
  on(eventType: string, handler: EventHandler): this;
  on(eventTypeOrDescriptor: string | EventDescriptor<unknown>, handler: EventHandler): this {
    const eventType =
      typeof eventTypeOrDescriptor === 'string'
        ? eventTypeOrDescriptor
        : eventTypeOrDescriptor.name;
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler as EventHandler);
    this.handlers.set(eventType, existing);
    return this;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.stopping = false;
    this.logger.info('starting', {
      meta: {
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
        registeredTypes: [...this.handlers.keys()],
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
      const events = await this.bus.claim(this.instanceId, this.batchSize);

      for (const event of events) {
        if (this.stopping) break;

        if (
          event.sourceService === this.sourceService &&
          this.skipOwnEventKinds.has(event.eventKind)
        ) {
          await this.bus.markDone(event.id);
          continue;
        }

        const handlers = this.handlers.get(event.eventType);
        if (!handlers || handlers.length === 0) {
          this.onProcessed?.(event);
          await this.bus.markDone(event.id);
          continue;
        }

        let allSucceeded = true;
        let lastError: string | undefined;
        for (const handler of handlers) {
          const failure = await this.executeWithRetry(event, handler);
          if (failure !== undefined) {
            allSucceeded = false;
            lastError = failure;
          }
        }

        if (allSucceeded) {
          this.onProcessed?.(event);
          await this.bus.markDone(event.id);
        } else {
          await this.bus.markFailed(event.id, lastError ?? 'unknown failure');
        }
      }
    } catch (err) {
      this.logger.error('tick error', err);
    }
  }

  private async sweepStale(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.staleClaimAfterMs);
      const reset = await this.bus.resetStale(cutoff);
      if (reset > 0) {
        this.logger.warn(`reset ${reset} stale CLAIMED row(s)`, {
          meta: { cutoff: cutoff.toISOString() },
        });
      }
    } catch (err) {
      this.logger.error('stale sweep failed', err);
    }
  }

  private async executeWithRetry(
    event: EventBusEntry,
    handler: EventHandler,
  ): Promise<string | undefined> {
    const maxAttempts = this.retryDelaysMs.length + 1;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.stopping) return lastError ?? 'shutdown in progress';
      try {
        const run = async () =>
          handler({
            payload: this.unwrapPayload(event.payload),
            eventType: event.eventType,
            eventVersion: event.eventVersion,
            ...(event.aggregateId !== undefined ? { aggregateId: event.aggregateId } : {}),
            ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
          });
        const ctx = this.buildExecutionContext(event);
        if (ctx && this.executionContext) {
          await this.executionContext.provider.runWithContext(ctx, run);
        } else {
          await run();
        }
        return undefined;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const delayMs = this.retryDelaysMs[attempt - 1];
        if (attempt >= maxAttempts || delayMs === undefined) {
          this.logger.error(`handler failed after ${attempt} attempt(s)`, err, {
            meta: { eventId: event.id, eventType: event.eventType, attempt },
          });
          return lastError;
        }
        this.logger.warn(`handler failed, retrying in ${delayMs}ms`, {
          meta: {
            eventId: event.id,
            eventType: event.eventType,
            attempt,
            maxAttempts,
            error: lastError,
          },
        });
        await this.sleep(delayMs);
      }
    }
    return lastError;
  }

  private unwrapPayload(payload: unknown): unknown {
    if (payload && typeof payload === 'object' && 'payload' in payload) {
      return (payload as { payload: unknown }).payload;
    }
    return payload;
  }

  private buildExecutionContext(event: EventBusEntry): ExecutionContext | undefined {
    if (!this.executionContext) return undefined;
    const { factory } = this.executionContext;
    const outer = event.payload as { metadata?: unknown } | null | undefined;
    const meta = outer && typeof outer === 'object' ? outer.metadata : undefined;
    if (meta) {
      return factory.createFromEventMetadata(
        meta as Parameters<ExecutionContextFactory['createFromEventMetadata']>[0],
      );
    }
    return factory.createSystemContext('system');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
