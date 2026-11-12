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
import type { HandlerOutcome, HandlerOutcomeStore } from './handler-outcome-store.interface.js';
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
  readonly key: string | undefined;
};

type KeyOption = { readonly key?: string | undefined };

const NO_OUTCOMES: ReadonlyMap<string, readonly HandlerOutcome[]> = new Map();

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
  /**
   * Records each handler's outcome when an attempt fails, so a redelivery runs only the
   * handlers that haven't finished. Event types with several handlers then need a `key` on each,
   * checked as each handler is registered.
   */
  readonly handlerOutcomes?: HandlerOutcomeStore;
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
  private readonly handlerOutcomes: HandlerOutcomeStore | undefined;
  private readonly leases: ClaimLeaseManager;
  private readonly handlers = new Map<string, readonly Registration[]>();
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
    this.handlerOutcomes = options.handlerOutcomes;
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

  on<TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: EventHandler<TPayload>,
    options?: KeyOption,
  ): this;
  on<TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: ScopedEventHandler<TPayload>,
    options: { readonly requires: 'scope' } & KeyOption,
  ): this;
  on<TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: SessionEventHandler<TPayload>,
    options: { readonly requires: 'session' } & KeyOption,
  ): this;
  on(eventType: string, handler: EventHandler, options?: KeyOption): this;
  on(
    eventType: string,
    handler: ScopedEventHandler,
    options: { readonly requires: 'scope' } & KeyOption,
  ): this;
  on(
    eventType: string,
    handler: SessionEventHandler,
    options: { readonly requires: 'session' } & KeyOption,
  ): this;
  on(
    eventTypeOrDescriptor: string | EventDescriptor<unknown>,
    handler: EventHandler | ScopedEventHandler | SessionEventHandler,
    options?: { readonly requires?: ContextRequirement | undefined } & KeyOption,
  ): this {
    // The overloads pair each narrowed handler with the requirement checked before it runs.
    return this.register(
      eventTypeOrDescriptor,
      handler as EventHandler,
      options?.requires,
      options?.key,
    );
  }

  subscribe(subscriptions: ReadonlyArray<EventSubscription<unknown>>): this {
    for (const sub of subscriptions) {
      // Arrow preserves `this` for class-based subscriptions — a bare method ref detaches.
      this.register(sub.descriptor, (entry) => sub.handle(entry), sub.requires, sub.key);
    }
    return this;
  }

  private register(
    eventTypeOrDescriptor: string | EventDescriptor<unknown>,
    handler: EventHandler,
    requires: ContextRequirement | undefined,
    key: string | undefined,
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
    const registrations = [
      ...(this.handlers.get(eventType) ?? []),
      { handler: wrapped, requires, key },
    ];
    this.assertKeys(eventType, registrations);
    this.handlers.set(eventType, registrations);
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
      const outcomes = await this.loadOutcomes(events);

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
        await this.dispatch(event, handlers, outcomes.get(event.id));
      }
    } catch (err) {
      this.logger.error('tick error', err);
    } finally {
      await this.leases.finish();
    }
  }

  private async dispatch(
    event: EventBusEntry,
    registrations: readonly Registration[],
    prior: readonly HandlerOutcome[] | undefined,
  ): Promise<void> {
    const meta = { eventId: event.id, eventType: event.eventType };
    const tracked = this.tracks(registrations);
    const priorByKey = tracked && prior ? new Map(prior.map((o) => [o.key, o])) : undefined;
    const fields = this.entryFields(event);
    const failures: HandlerFailure[] = [];
    const recorded: HandlerOutcome[] = [];
    let skippedDead: HandlerOutcome | undefined;
    let ran = 0;

    for (const registration of registrations) {
      const key = tracked ? registration.key : undefined;
      const previous = key !== undefined ? priorByKey?.get(key) : undefined;
      if (previous) {
        this.logger.debug('skipping handler; outcome already recorded', {
          meta: { ...meta, handlerKey: previous.key, outcome: previous.outcome },
        });
        if (previous.outcome === 'dead') skippedDead = previous;
        continue;
      }
      ran++;
      const failure = await this.executeWithRetry(event, fields, registration);
      if (failure) failures.push(failure);
      if (key === undefined) continue;
      if (!failure) recorded.push({ key, outcome: 'done' });
      else if (failure.permanent) recorded.push({ key, outcome: 'dead', error: failure.message });
    }

    if (failures.length === 0 && !skippedDead) {
      this.callHook('onProcessed', event.id, () => this.onProcessed?.(event));
      await this.leases.settle(event, 'done', () => this.bus.markDone(event.id, this.instanceId));
      return;
    }

    // Written before settling: if the process dies in between, the outcomes are still true.
    if (recorded.length > 0) await this.recordOutcomes(event, recorded);
    // Only when every failure is permanent: a transient one may still succeed on redelivery.
    const permanent = failures.every((f) => f.permanent);
    const message =
      failures.at(-1)?.message ?? skippedDead?.error ?? 'handler failed permanently earlier';
    if (ran === 0) {
      this.logger.warn(
        'dead-lettering without running a handler: every remaining one failed permanently earlier; replay with bus.replay() (or clear its handler outcomes) to re-run them',
        { meta },
      );
    }
    const failed = await this.leases.settle(event, 'failed', () =>
      permanent
        ? this.bus.markFailedPermanently(event.id, message, this.instanceId)
        : this.bus.markFailed(event.id, message, this.instanceId),
    );
    if (failed) this.callHook('onFailed', event.id, () => this.onFailed?.(failed, { permanent }));
  }

  private async loadOutcomes(
    events: readonly EventBusEntry[],
  ): Promise<ReadonlyMap<string, readonly HandlerOutcome[]>> {
    const store = this.handlerOutcomes;
    if (!store) return NO_OUTCOMES;
    const ids = events.filter((e) => this.tracks(this.handlers.get(e.eventType))).map((e) => e.id);
    if (ids.length === 0) return NO_OUTCOMES;
    try {
      return await store.load(ids);
    } catch (err) {
      this.logger.error('loading handler outcomes failed; running every handler', err, {
        meta: { eventIds: ids },
      });
      return NO_OUTCOMES;
    }
  }

  private async recordOutcomes(
    event: EventBusEntry,
    outcomes: readonly HandlerOutcome[],
  ): Promise<void> {
    try {
      await this.handlerOutcomes?.record(event.id, outcomes);
    } catch (err) {
      this.logger.error('recording handler outcomes failed; they will run again', err, {
        meta: { eventId: event.id, eventType: event.eventType },
      });
    }
  }

  // One handler re-runs alone on redelivery, so only event types with several are tracked.
  private tracks(registrations: readonly Registration[] | undefined): boolean {
    return this.handlerOutcomes !== undefined && (registrations?.length ?? 0) > 1;
  }

  private assertKeys(eventType: string, registrations: readonly Registration[]): void {
    if (!this.tracks(registrations)) return;
    const seen = new Set<string>();
    for (const { key } of registrations) {
      if (!key) {
        throw new Error(
          `EventConsumer: "${eventType}" has ${registrations.length} handlers and \`handlerOutcomes\` is wired, so each handler needs a \`key\``,
        );
      }
      if (seen.has(key)) {
        throw new Error(`EventConsumer: duplicate handler key "${key}" for "${eventType}"`);
      }
      seen.add(key);
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
