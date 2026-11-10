import { randomUUID } from 'node:crypto';
import { ValidationError } from '@quilla-be-kit/errors';
import {
  type ContextRequirement,
  type ExecutionContext,
  type ExecutionContextFactory,
  type ExecutionContextProvider,
  type ExecutionContextView,
  MissingScopeError,
  MissingSessionError,
  readAttemptContext,
  requireContext,
  toExecutionContextView,
} from '@quilla-be-kit/execution-context';
import type { Logger } from '@quilla-be-kit/observability';
import type { Disposable } from '@quilla-be-kit/runtime';
import { ClaimLeaseManager } from './claim-lease.manager.js';
import type { LeaseLostInfo } from './claim-lease.type.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_STALE_CLAIM_MS,
} from './defaults.js';
import type { EventBusConsumer } from './event-bus-consumer.interface.js';
import type { EventBusEntry } from './event-bus-entry.type.js';
import type { EventSubscription } from './event-subscription.interface.js';
import type { EventDescriptor } from './event.descriptor.js';
import { type HandlerEntryFields, createHandlerEntry } from './handler-entry.factory.js';
import type {
  HandlerEntry,
  ScopedHandlerEntry,
  SessionHandlerEntry,
} from './handler-entry.type.js';
import type { StandardSchemaV1 } from './standard-schema.type.js';

export type EventHandler<TPayload = unknown> = (entry: HandlerEntry<TPayload>) => Promise<void>;
export type ScopedEventHandler<TPayload = unknown> = (
  entry: ScopedHandlerEntry<TPayload>,
) => Promise<void>;
export type SessionEventHandler<TPayload = unknown> = (
  entry: SessionHandlerEntry<TPayload>,
) => Promise<void>;

type Registration = {
  readonly handler: EventHandler;
  readonly requires: ContextRequirement | undefined;
};

type HandlerFailure = { readonly message: string; readonly permanent: boolean };

/** Passed to `onFailed`: `permanent` failures are dead-lettered on the first attempt. */
export type EventFailureInfo = { readonly permanent: boolean };

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
  readonly renewIntervalMs?: number;
  readonly instanceId?: string;
  readonly executionContext?: {
    readonly provider: ExecutionContextProvider;
  };
  readonly onProcessed?: (entry: EventBusEntry) => void;
  // After each failed attempt is recorded; `entry.status === 'FAILED'` means dead-lettered.
  // Not called when the claim was lost (onLeaseLost reports it).
  readonly onFailed?: (entry: EventBusEntry, info: EventFailureInfo) => void;
  /**
   * Classifies a handler error a retry cannot fix; the event is then dead-lettered on the
   * first attempt. Schema, missing-context and context-rebuild errors always are.
   */
  readonly isPermanentFailure?: (
    error: unknown,
    info: { readonly entry: EventBusEntry },
  ) => boolean;
  readonly onLeaseLost?: (info: LeaseLostInfo) => void;
  readonly subscriptions?: ReadonlyArray<EventSubscription<unknown>>;
};

export class SchemaValidationError extends ValidationError {
  readonly eventType: string;
  readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

  constructor(eventType: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    const summary = issues.map((i) => `${formatIssuePath(i.path)}${i.message}`).join('; ');
    super({
      message: `schema validation failed for ${eventType}: ${summary}`,
      context: { eventType, issues },
    });
    this.eventType = eventType;
    this.issues = issues;
  }
}

function formatIssuePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string {
  if (!path || path.length === 0) return '';
  const parts = path.map((seg) =>
    typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg),
  );
  return `${parts.join('.')}: `;
}

function wrapWithSchema(
  eventType: string,
  schema: StandardSchemaV1,
  handler: EventHandler,
): EventHandler {
  return async (entry) => {
    const result = await schema['~standard'].validate(entry.payload);
    if (result.issues !== undefined) {
      throw new SchemaValidationError(eventType, result.issues);
    }
    return handler({ ...entry, payload: result.value });
  };
}

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
  private readonly onProcessed: EventConsumerOptions['onProcessed'];
  private readonly onFailed: EventConsumerOptions['onFailed'];
  private readonly isPermanentFailure: EventConsumerOptions['isPermanentFailure'];
  private readonly leases: ClaimLeaseManager;
  private readonly handlers = new Map<string, Registration[]>();
  private topicKeys: readonly string[] = [];

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private inflightTick: Promise<void> | null = null;
  private stopping = false;

  constructor(options: EventConsumerOptions) {
    this.bus = options.bus;
    this.consumerName = options.consumerName;
    this.sourceService = options.sourceService;
    this.logger = options.logger.withMeta({ consumerName: options.consumerName });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.skipOwnEventKinds = new Set(options.skipOwnEventKinds ?? []);
    this.staleClaimAfterMs = options.staleClaimAfterMs ?? DEFAULT_STALE_CLAIM_MS;
    this.instanceId = options.instanceId ?? randomUUID();
    this.executionContext = options.executionContext;
    this.onProcessed = options.onProcessed;
    this.onFailed = options.onFailed;
    this.isPermanentFailure = options.isPermanentFailure;
    this.leases = new ClaimLeaseManager({
      lease: options.bus.lease,
      instanceId: this.instanceId,
      renewIntervalMs: options.renewIntervalMs,
      logger: this.logger,
      onLeaseLost: options.onLeaseLost,
    });
    if (options.subscriptions) {
      this.subscribe(options.subscriptions);
    }
  }

  get name(): string {
    return `EventConsumer:${this.consumerName}`;
  }

  get registeredEventTypes(): readonly string[] {
    return this.topicKeys;
  }

  on<TPayload>(descriptor: EventDescriptor<TPayload>, handler: EventHandler<TPayload>): this;
  on<TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: ScopedEventHandler<TPayload>,
    options: { readonly requires: 'scope' },
  ): this;
  on<TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: SessionEventHandler<TPayload>,
    options: { readonly requires: 'session' },
  ): this;
  on(eventType: string, handler: EventHandler): this;
  on(eventType: string, handler: ScopedEventHandler, options: { readonly requires: 'scope' }): this;
  on(
    eventType: string,
    handler: SessionEventHandler,
    options: { readonly requires: 'session' },
  ): this;
  on(
    eventTypeOrDescriptor: string | EventDescriptor<unknown>,
    handler: EventHandler | ScopedEventHandler | SessionEventHandler,
    options?: { readonly requires?: ContextRequirement | undefined },
  ): this {
    // The overloads pair each narrowed handler with the requirement checked before it runs.
    return this.register(eventTypeOrDescriptor, handler as EventHandler, options?.requires);
  }

  subscribe(subscriptions: ReadonlyArray<EventSubscription<unknown>>): this {
    for (const sub of subscriptions) {
      // Arrow preserves `this` for class-based subscriptions — a bare method ref detaches.
      this.register(sub.descriptor, (entry) => sub.handle(entry), sub.requires);
    }
    return this;
  }

  private register(
    eventTypeOrDescriptor: string | EventDescriptor<unknown>,
    handler: EventHandler,
    requires: ContextRequirement | undefined,
  ): this {
    const eventType =
      typeof eventTypeOrDescriptor === 'string'
        ? eventTypeOrDescriptor
        : eventTypeOrDescriptor.name;
    if (requires !== undefined && !this.executionContext) {
      throw new Error(
        `EventConsumer: a handler for "${eventType}" requires a ${requires}, but no \`executionContext\` is wired; pass \`executionContext: { provider }\``,
      );
    }
    const schema =
      typeof eventTypeOrDescriptor === 'string' ? undefined : eventTypeOrDescriptor.schema;
    const wrapped: EventHandler =
      schema !== undefined ? wrapWithSchema(eventType, schema, handler) : handler;
    const isNewType = !this.handlers.has(eventType);
    const existing = this.handlers.get(eventType) ?? [];
    existing.push({ handler: wrapped, requires });
    this.handlers.set(eventType, existing);
    if (isNewType) this.topicKeys = [...this.handlers.keys()];
    return this;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.stopping = false;
    this.logger.info('starting', {
      meta: {
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
        registeredTypeCount: this.handlers.size,
        instanceId: this.instanceId,
        leaseMs: this.leases.leaseMs,
        renewIntervalMs: this.leases.renewIntervalMs,
      },
    });
    this.leases.warnIfDisabled();
    this.logger.debug('registered event types', {
      meta: { registeredTypes: this.registeredEventTypes },
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
      if (this.topicKeys.length === 0) return;
      const events = await this.bus.claim(this.instanceId, this.batchSize, this.topicKeys);
      this.leases.begin(events);

      for (const event of events) {
        if (this.stopping) break;
        if (!(await this.leases.acquire(event))) continue;

        if (
          event.sourceService === this.sourceService &&
          this.skipOwnEventKinds.has(event.eventKind)
        ) {
          await this.leases.settle(event, 'done', () =>
            this.bus.markDone(event.id, this.instanceId),
          );
          continue;
        }

        const handlers = this.handlers.get(event.eventType);
        if (!handlers) {
          // Broker contract violation; don't ack so stale-claim recovery surfaces it.
          this.logger.error('broker delivered event for unregistered type', undefined, {
            meta: { eventId: event.id, eventType: event.eventType },
          });
          continue;
        }

        this.leases.hold(event);
        const fields = this.entryFields(event);
        const failures: HandlerFailure[] = [];
        for (const registration of handlers) {
          const failure = await this.executeWithRetry(event, fields, registration);
          if (failure) failures.push(failure);
        }

        const last = failures.at(-1);
        if (!last) {
          this.callHook('onProcessed', event.id, () => this.onProcessed?.(event));
          await this.leases.settle(event, 'done', () =>
            this.bus.markDone(event.id, this.instanceId),
          );
          continue;
        }
        // Only when every failure is permanent: a transient one may still succeed on redelivery.
        const permanent = failures.every((f) => f.permanent);
        const failed = await this.leases.settle(event, 'failed', () =>
          permanent
            ? this.bus.markFailedPermanently(event.id, last.message, this.instanceId)
            : this.bus.markFailed(event.id, last.message, this.instanceId),
        );
        if (failed)
          this.callHook('onFailed', event.id, () => this.onFailed?.(failed, { permanent }));
      }
    } catch (err) {
      this.logger.error('tick error', err);
    } finally {
      await this.leases.finish();
    }
  }

  private callHook(name: string, eventId: string, call: () => void): void {
    try {
      call();
    } catch (err) {
      this.logger.error(`${name} hook threw`, err, { meta: { eventId } });
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

  private entryFields(event: EventBusEntry): HandlerEntryFields {
    return {
      id: event.id,
      payload: this.unwrapPayload(event.payload),
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      occurredAt: event.occurredAt,
      ...(event.aggregateId !== undefined ? { aggregateId: event.aggregateId } : {}),
      ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
    };
  }

  private async executeWithRetry(
    event: EventBusEntry,
    fields: HandlerEntryFields,
    { handler, requires }: Registration,
  ): Promise<HandlerFailure | undefined> {
    const meta = { eventId: event.id, eventType: event.eventType };
    // Rebuilding the context and checking the requirement depend only on the event.
    let firstCtx: ExecutionContext | undefined;
    try {
      firstCtx = this.buildExecutionContext(event);
      if (requires !== undefined && firstCtx) requireContext(firstCtx, requires);
    } catch (err) {
      this.logger.error('handler context is unusable; dead-lettering', err, { meta });
      return { message: errorMessage(err), permanent: true };
    }

    const maxAttempts = this.retryDelaysMs.length + 1;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.stopping) return { message: lastError ?? 'shutdown in progress', permanent: false };
      try {
        // Each retry is a new attempt, so it gets a fresh context (and executionAttemptId).
        const ctx = attempt === 1 ? firstCtx : this.buildExecutionContext(event);
        const entry = createHandlerEntry(fields, () => this.readContext(ctx, requires));
        const run = async () => handler(entry);
        if (ctx && this.executionContext) {
          await this.executionContext.provider.runWithContext(ctx, run);
        } else {
          await run();
        }
        return undefined;
      } catch (err) {
        lastError = errorMessage(err);
        if (this.isPermanent(err, event, meta)) {
          this.logger.error('permanent handler failure; skipping retries', err, {
            meta: err instanceof SchemaValidationError ? { ...meta, issues: err.issues } : meta,
          });
          return { message: lastError, permanent: true };
        }
        const delayMs = this.retryDelaysMs[attempt - 1];
        if (attempt >= maxAttempts || delayMs === undefined) {
          this.logger.error(`handler failed after ${attempt} attempt(s)`, err, {
            meta: { ...meta, attempt },
          });
          return { message: lastError, permanent: false };
        }
        this.logger.warn(`handler failed, retrying in ${delayMs}ms`, {
          meta: { ...meta, attempt, maxAttempts, error: lastError },
        });
        await this.sleep(delayMs);
      }
    }
    return { message: lastError ?? 'unknown failure', permanent: false };
  }

  private isPermanent(
    err: unknown,
    entry: EventBusEntry,
    meta: Readonly<Record<string, unknown>>,
  ): boolean {
    if (
      err instanceof SchemaValidationError ||
      MissingScopeError.is(err) ||
      MissingSessionError.is(err)
    ) {
      return true;
    }
    if (!this.isPermanentFailure) return false;
    try {
      return this.isPermanentFailure(err, { entry });
    } catch (predicateError) {
      // A broken classifier must never leave the event unsettled: treat the failure as transient.
      this.logger.error(
        'isPermanentFailure threw; treating the failure as transient',
        predicateError,
        { meta },
      );
      return false;
    }
  }

  private readContext(
    dispatched: ExecutionContext | undefined,
    requires: ContextRequirement | undefined,
  ): ExecutionContextView {
    if (!this.executionContext || !dispatched) {
      throw new Error(
        'HandlerEntry.getContext(): this EventConsumer has no `executionContext` wired; pass `executionContext: { provider }` to read the context in handlers',
      );
    }
    const current = readAttemptContext(
      this.executionContext.provider,
      dispatched.executionAttemptId,
    );
    if (!current) {
      throw new Error(
        'HandlerEntry.getContext() was called outside the dispatch of its handler; read the context while the handler runs',
      );
    }
    if (requires !== undefined) requireContext(current, requires);
    return toExecutionContextView(current);
  }

  private unwrapPayload(payload: unknown): unknown {
    if (payload && typeof payload === 'object' && 'payload' in payload) {
      return (payload as { payload: unknown }).payload;
    }
    return payload;
  }

  private buildExecutionContext(event: EventBusEntry): ExecutionContext | undefined {
    if (!this.executionContext) return undefined;
    const { factory } = this.executionContext.provider;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
