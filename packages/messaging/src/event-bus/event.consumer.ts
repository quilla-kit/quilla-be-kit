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
import type { ClaimOptions } from './claim-options.type.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DELIVERY_BATCH_SIZE,
  DEFAULT_FAILOVER_WINDOW_POLLS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_STALE_CLAIM_MS,
  retryDelayFor,
} from './defaults.js';
import type { DeliveryEntry, DeliveryPair, NewDelivery } from './delivery-entry.type.js';
import type { DeliveryQueue } from './delivery-queue.interface.js';
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
import { type RetryPolicy, type RetrySchedule, nextAttemptAt } from './retry.policy.js';
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

type KeyOption = Pick<EventSubscription<unknown>, 'key' | 'retry' | 'previousKeys'>;

type RegisterOptions = KeyOption & { readonly requires?: ContextRequirement | undefined };

type DeliveryWork = {
  readonly queue: DeliveryQueue;
  readonly leases: ClaimLeaseManager<DeliveryEntry>;
};

type PollLoop = { readonly timer: ReturnType<typeof setInterval>; inflight: Promise<void> | null };

const NO_OUTCOMES: ReadonlyMap<string, readonly HandlerOutcome[]> = new Map();

type HandlerFailure = { readonly message: string; readonly permanent: boolean };

/**
 * `source` says what `entry` is: the bus event, or (under isolation) one subscriber's delivery,
 * which `bus.deliveries.replay` takes.
 */
export type EventProcessedInfo = {
  readonly source: 'event' | 'delivery';
  readonly handlerKey?: string | undefined;
};

/** Passed to `onFailed`: `permanent` failures are dead-lettered on the first attempt. */
export type EventFailureInfo = EventProcessedInfo & { readonly permanent: boolean };

export type EventConsumerOptions = {
  readonly bus: EventBusConsumer;
  readonly consumerName: string;
  readonly sourceService: string;
  readonly logger: Logger;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  /**
   * Wait before each retry: the n-th retry waits `retryDelaysMs[n - 1]`, the last value
   * repeating. The bus's `maxRetries` caps the attempts. The event is handed back while it waits.
   */
  readonly retryDelaysMs?: readonly number[];
  readonly skipOwnEventKinds?: readonly string[];
  readonly staleClaimAfterMs?: number;
  readonly renewIntervalMs?: number;
  readonly instanceId?: string;
  /**
   * After this instance fails an event, other instances get this long to claim it first.
   * Default: twice `pollIntervalMs`. `0` turns it off.
   */
  readonly failoverWindowMs?: number;
  /**
   * Isolates subscribers: a handler that fails moves to its own delivery, retried by its `retry`
   * policy, while the event's other handlers and the aggregate's later events go on. Needs a bus
   * with `deliveries`, a `key` on every handler, and no `handlerOutcomes`.
   */
  readonly isolation?: boolean;
  /** Default attempt budget of a delivery (default `retryDelaysMs.length + 1`; `Infinity`: none). */
  readonly maxAttempts?: number;
  /** Deliveries claimed per poll. Default 10. */
  readonly deliveryBatchSize?: number;
  readonly executionContext?: {
    readonly provider: ExecutionContextProvider;
  };
  readonly onProcessed?: (entry: EventBusEntry, info: EventProcessedInfo) => void;
  // After each failed attempt is recorded; `entry.status === 'FAILED'` means dead-lettered.
  // Not called when the claim was lost (onLeaseLost reports it). Under isolation, failures are
  // reported on the deliveries they created.
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
  private readonly claimOptions: ClaimOptions;
  private readonly executionContext: EventConsumerOptions['executionContext'];
  private readonly onProcessed: EventConsumerOptions['onProcessed'];
  private readonly onFailed: EventConsumerOptions['onFailed'];
  private readonly isPermanentFailure: EventConsumerOptions['isPermanentFailure'];
  private readonly handlerOutcomes: HandlerOutcomeStore | undefined;
  private readonly leases: ClaimLeaseManager;
  private readonly handlers = new Map<string, readonly Registration[]>();
  private topicKeys: readonly string[] = [];
  // Deliveries drain whenever the bus offers them; `isolated` is the same work, set only with
  // `isolation`, when failures split into deliveries.
  private readonly delivery: DeliveryWork | undefined;
  private readonly isolated: DeliveryWork | undefined;
  private readonly maxAttempts: number | undefined;
  private readonly deliveryBatchSize: number;
  private readonly policies = new Map<string, RetryPolicy>();
  private readonly previousKeys = new Map<string, Set<string>>();
  private deliveryPairs: readonly DeliveryPair[] = [];
  private ready: Promise<boolean> | undefined;

  private loops: PollLoop[] = [];
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
    this.claimOptions = {
      failoverWindowMs:
        options.failoverWindowMs ?? DEFAULT_FAILOVER_WINDOW_POLLS * this.pollIntervalMs,
    };
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
    const queue = options.bus.deliveries;
    if (options.isolation && !queue) {
      throw new Error(
        'EventConsumer: `isolation` needs a bus with `deliveries` (e.g. `new PgEventBus({ deliveries: true })`)',
      );
    }
    if (options.isolation && this.handlerOutcomes) {
      throw new Error(
        'EventConsumer: `isolation` and `handlerOutcomes` are exclusive; isolation already keeps a finished handler from re-running when a sibling fails',
      );
    }
    if (options.maxAttempts !== undefined) assertMaxAttempts(options.maxAttempts, 'maxAttempts');
    this.maxAttempts = options.maxAttempts;
    this.deliveryBatchSize = options.deliveryBatchSize ?? DEFAULT_DELIVERY_BATCH_SIZE;
    this.delivery = queue && {
      queue,
      leases: new ClaimLeaseManager<DeliveryEntry>({
        lease: queue.lease,
        instanceId: this.instanceId,
        renewIntervalMs: options.renewIntervalMs,
        logger: this.logger,
        onLeaseLost: options.onLeaseLost,
        orderKey: (d) =>
          d.aggregateId === undefined ? undefined : laneKey(d.handlerKey, d.aggregateId),
      }),
    };
    this.isolated = options.isolation ? this.delivery : undefined;
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
    return this.register(eventTypeOrDescriptor, handler as EventHandler, options ?? {});
  }

  subscribe(subscriptions: ReadonlyArray<EventSubscription<unknown>>): this {
    for (const sub of subscriptions) {
      // Arrow preserves `this` for class-based subscriptions — a bare method ref detaches.
      this.register(sub.descriptor, (entry) => sub.handle(entry), sub);
    }
    return this;
  }

  private register(
    eventTypeOrDescriptor: string | EventDescriptor<unknown>,
    handler: EventHandler,
    { requires, key, retry, previousKeys }: RegisterOptions,
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
    if (key !== undefined) this.registerSubscriber(eventType, key, retry, previousKeys);
    this.handlers.set(eventType, registrations);
    if (isNewType) this.topicKeys = [...this.handlers.keys()];
    if (key !== undefined) {
      this.deliveryPairs = [...this.handlers].flatMap(([type, regs]) =>
        regs.flatMap((r) => (r.key === undefined ? [] : [{ key: r.key, eventType: type }])),
      );
    }
    return this;
  }

  // One policy per subscriber: a policy given on one of its event types covers all of them.
  private registerSubscriber(
    eventType: string,
    key: string,
    retry: RetryPolicy | undefined,
    previousKeys: readonly string[] | undefined,
  ): void {
    if (retry) {
      if (retry.maxAttempts !== undefined) {
        assertMaxAttempts(retry.maxAttempts, `retry.maxAttempts of "${key}"`);
      }
      const existing = this.policies.get(key);
      if (existing && !samePolicy(existing, retry)) {
        throw new Error(
          `EventConsumer: subscriber "${key}" has two different retry policies (on "${eventType}"); give it one`,
        );
      }
      this.policies.set(key, retry);
    }
    if (previousKeys && previousKeys.length > 0) {
      const known = this.previousKeys.get(key) ?? new Set<string>();
      for (const previous of previousKeys) known.add(previous);
      this.previousKeys.set(key, known);
    }
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.stopping = false;
    this.logger.info('starting', {
      meta: {
        pollIntervalMs: this.pollIntervalMs,
        batchSize: this.batchSize,
        registeredTypeCount: this.handlers.size,
        instanceId: this.instanceId,
        failoverWindowMs: this.claimOptions.failoverWindowMs,
        isolation: this.isolated !== undefined,
        leaseMs: this.leases.leaseMs,
        renewIntervalMs: this.leases.renewIntervalMs,
      },
    });
    this.leases.warnIfDisabled();
    this.logger.debug('registered event types', {
      meta: { registeredTypes: this.registeredEventTypes },
    });
    this.poll(() => this.tick());
    // Its own loop, so a slow subscriber's retries never hold up the event path.
    const delivery = this.delivery;
    if (delivery) this.poll(() => this.deliveryTick(delivery));
  }

  private poll(run: () => Promise<void>): void {
    const loop: PollLoop = {
      timer: setInterval(() => {
        if (this.stopping || loop.inflight) return;
        loop.inflight = run().finally(() => {
          loop.inflight = null;
        });
      }, this.pollIntervalMs),
      inflight: null,
    };
    this.loops.push(loop);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    const loops = this.loops;
    this.loops = [];
    for (const loop of loops) clearInterval(loop.timer);
    await Promise.all(loops.map((loop) => loop.inflight?.catch(() => {})));
    this.logger.info('stopped');
  }

  private async tick(): Promise<void> {
    try {
      await this.sweepStale(this.bus);
      if (this.topicKeys.length === 0) return;
      const isolated = this.isolated;
      if (isolated && !(await this.prepare(isolated.queue))) return;
      const events = await this.bus.claim(
        this.instanceId,
        this.batchSize,
        this.topicKeys,
        this.claimOptions,
      );
      this.leases.begin(events);
      // Throws to the catch below, which hands the batch back: never run on unknown lanes.
      const lanes = isolated && (await this.loadLanes(isolated.queue, events));
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
        if (isolated && lanes) await this.dispatchIsolated(isolated.queue, event, handlers, lanes);
        else await this.dispatch(event, handlers, outcomes.get(event.id));
      }
    } catch (err) {
      this.logger.error('tick error', err);
    } finally {
      await this.leases.finish();
    }
  }

  private async loadLanes(
    queue: DeliveryQueue,
    events: readonly EventBusEntry[],
  ): Promise<Set<string>> {
    const aggregateIds = [
      ...new Set(events.flatMap((e) => (e.aggregateId !== undefined ? [e.aggregateId] : []))),
    ];
    const open = await queue.openLanes(this.consumerName, aggregateIds);
    return new Set(open.map((lane) => laneKey(lane.handlerKey, lane.aggregateId)));
  }

  // Each handler runs once; one that fails, or whose lane already holds earlier work, gets a
  // delivery of its own. The event row is settled either way, freeing the aggregate.
  private async dispatchIsolated(
    queue: DeliveryQueue,
    event: EventBusEntry,
    registrations: readonly Registration[],
    lanes: Set<string>,
  ): Promise<void> {
    const fields = this.entryFields(event);
    const queued: NewDelivery[] = [];
    const permanent = new Set<string>();
    for (const registration of registrations) {
      const key = registration.key ?? '';
      const lane = event.aggregateId !== undefined ? laneKey(key, event.aggregateId) : undefined;
      if (lane !== undefined && lanes.has(lane)) {
        queued.push({ handlerKey: key, status: 'PENDING', retryCount: 0 });
        continue;
      }
      const failure = await this.execute(event, fields, registration);
      if (!failure) continue;
      if (failure.permanent) permanent.add(key);
      queued.push(this.firstFailure(key, failure));
    }

    if (queued.length === 0) {
      this.callHook('onProcessed', event.id, () => this.onProcessed?.(event, { source: 'event' }));
      await this.leases.settle(event, 'done', () => this.bus.markDone(event.id, this.instanceId));
      return;
    }
    const created = await this.leases.settle(event, 'done', () =>
      queue.settle(event.id, this.consumerName, queued, this.instanceId),
    );
    if (!created) return;
    for (const delivery of queued) {
      if (event.aggregateId !== undefined && delivery.status === 'PENDING') {
        lanes.add(laneKey(delivery.handlerKey, event.aggregateId));
      }
    }
    for (const delivery of created) {
      if (delivery.retryCount === 0) continue;
      const info = {
        permanent: permanent.has(delivery.handlerKey),
        source: 'delivery',
        handlerKey: delivery.handlerKey,
      } as const;
      this.callHook('onFailed', delivery.id, () => this.onFailed?.(delivery, info));
    }
  }

  private firstFailure(key: string, failure: HandlerFailure): NewDelivery {
    const base = {
      handlerKey: key,
      retryCount: 1,
      lastError: failure.message,
      lastFailedBy: this.instanceId,
    };
    const now = new Date();
    const next = failure.permanent ? undefined : nextAttemptAt(this.scheduleFor(key), 0, now, now);
    return next
      ? { ...base, status: 'PENDING', nextAttemptAt: next }
      : { ...base, status: 'FAILED' };
  }

  private async deliveryTick({ queue, leases }: DeliveryWork): Promise<void> {
    try {
      await this.sweepStale(queue);
      if (this.deliveryPairs.length === 0 || !(await this.prepare(queue))) return;
      const batch = await queue.claim(
        this.instanceId,
        this.deliveryBatchSize,
        this.consumerName,
        this.deliveryPairs,
        this.claimOptions,
      );
      leases.begin(batch);
      for (const delivery of batch) {
        if (this.stopping) break;
        if (!(await leases.acquire(delivery))) continue;
        const registration = this.handlers
          .get(delivery.eventType)
          ?.find((r) => r.key === delivery.handlerKey);
        if (!registration) {
          // Claims filter on registered pairs, so this is a broker contract violation.
          this.logger.error('delivery claimed for an unregistered subscriber', undefined, {
            meta: { deliveryId: delivery.id, handlerKey: delivery.handlerKey },
          });
          continue;
        }
        leases.hold(delivery);
        await this.runDelivery(queue, leases, delivery, registration);
      }
    } catch (err) {
      this.logger.error('delivery tick error', err);
    } finally {
      await leases.finish();
    }
  }

  private async runDelivery(
    queue: DeliveryQueue,
    leases: ClaimLeaseManager<DeliveryEntry>,
    delivery: DeliveryEntry,
    registration: Registration,
  ): Promise<void> {
    const key = delivery.handlerKey;
    // Handlers see the event's id on every attempt, so idempotency keys stay stable.
    const fields = { ...this.entryFields(delivery), id: delivery.eventId };
    const failure = await this.execute(delivery, fields, registration);
    if (!failure) {
      this.callHook('onProcessed', delivery.id, () =>
        this.onProcessed?.(delivery, { source: 'delivery', handlerKey: key }),
      );
      await leases.settle(delivery, 'done', () => queue.markDone(delivery.id, this.instanceId));
      return;
    }
    const now = new Date();
    const next = failure.permanent
      ? undefined
      : nextAttemptAt(this.scheduleFor(key), delivery.retryCount, delivery.queuedAt, now);
    const failed = await leases.settle(delivery, 'failed', () =>
      next
        ? queue.markFailed(delivery.id, failure.message, this.instanceId, {
            retryAfterMs: next.getTime() - now.getTime(),
          })
        : queue.markFailedPermanently(delivery.id, failure.message, this.instanceId),
    );
    const info = { permanent: failure.permanent, source: 'delivery', handlerKey: key } as const;
    if (failed) this.callHook('onFailed', delivery.id, () => this.onFailed?.(failed, info));
  }

  private scheduleFor(key: string): RetrySchedule {
    const policy = this.policies.get(key);
    const delaysMs = policy?.delaysMs ?? this.retryDelaysMs;
    return {
      delaysMs,
      maxAttempts: policy?.maxAttempts ?? this.maxAttempts ?? delaysMs.length + 1,
      maxAgeMs: policy?.maxAgeMs,
    };
  }

  // Once per process, before any dispatch: moves renamed subscribers' work to their key (so a
  // lane never spans two keys) and warns about work no handler here claims. Retried until it
  // succeeds; concurrent callers share one run.
  private prepare(queue: DeliveryQueue): Promise<boolean> {
    this.ready ??= this.runPrepare(queue).then((ok) => {
      if (!ok) this.ready = undefined;
      return ok;
    });
    return this.ready;
  }

  private async runPrepare(deliveries: DeliveryQueue): Promise<boolean> {
    try {
      for (const [key, previous] of this.previousKeys) {
        const moved = await deliveries.rekey(this.consumerName, [...previous], key);
        if (moved > 0) {
          this.logger.info(`moved ${moved} queued deliveries to renamed subscriber`, {
            meta: { handlerKey: key, previousKeys: [...previous] },
          });
        }
      }
      const orphans = await deliveries.countOrphans(this.consumerName, this.deliveryPairs);
      if (orphans > 0) {
        this.logger.warn(
          `${orphans} queued deliveries belong to subscribers this consumer doesn't register; a renamed key needs \`previousKeys\``,
          { meta: { orphans } },
        );
      }
      return true;
    } catch (err) {
      this.logger.error('preparing deliveries failed; will retry', err);
      return false;
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
      const failure = await this.execute(event, fields, registration);
      if (failure) failures.push(failure);
      if (key === undefined) continue;
      if (!failure) recorded.push({ key, outcome: 'done' });
      else if (failure.permanent) recorded.push({ key, outcome: 'dead', error: failure.message });
    }

    if (failures.length === 0 && !skippedDead) {
      this.callHook('onProcessed', event.id, () => this.onProcessed?.(event, { source: 'event' }));
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
        : this.bus.markFailed(event.id, message, this.instanceId, {
            retryAfterMs: retryDelayFor(this.retryDelaysMs, event.retryCount),
          }),
    );
    if (failed) {
      this.callHook('onFailed', event.id, () =>
        this.onFailed?.(failed, { permanent, source: 'event' }),
      );
    }
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
    if (!this.isolated && !this.tracks(registrations)) return;
    const seen = new Set<string>();
    for (const { key } of registrations) {
      if (!key && this.isolated) {
        throw new Error(
          `EventConsumer: under \`isolation\` every handler needs a \`key\` naming its subscriber ("${eventType}")`,
        );
      }
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

  private async sweepStale(target: Pick<EventBusConsumer, 'resetStale'>): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - this.staleClaimAfterMs);
      const reset = await target.resetStale(cutoff);
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

  // One attempt per claim: a retry is a later claim, possibly on another instance.
  private async execute(
    event: EventBusEntry,
    fields: HandlerEntryFields,
    { handler, requires }: Registration,
  ): Promise<HandlerFailure | undefined> {
    const meta = { eventId: event.id, eventType: event.eventType, attempt: event.retryCount + 1 };
    let ctx: ExecutionContext | undefined;
    try {
      ctx = this.buildExecutionContext(event);
      if (requires !== undefined && ctx) requireContext(ctx, requires);
    } catch (err) {
      this.logger.error('handler context is unusable; dead-lettering', err, { meta });
      return { message: errorMessage(err), permanent: true };
    }

    try {
      const entry = createHandlerEntry(fields, () => this.readContext(ctx, requires));
      const run = async () => handler(entry);
      if (ctx && this.executionContext) {
        await this.executionContext.provider.runWithContext(ctx, run);
      } else {
        await run();
      }
      return undefined;
    } catch (err) {
      if (this.isPermanent(err, event, meta)) {
        this.logger.error('permanent handler failure; skipping retries', err, {
          meta: err instanceof SchemaValidationError ? { ...meta, issues: err.issues } : meta,
        });
        return { message: errorMessage(err), permanent: true };
      }
      this.logger.error('handler failed', err, { meta });
      return { message: errorMessage(err), permanent: false };
    }
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
}

function laneKey(handlerKey: string, aggregateId: string): string {
  return `${handlerKey}\0${aggregateId}`;
}

function samePolicy(a: RetryPolicy, b: RetryPolicy): boolean {
  return (
    a.maxAttempts === b.maxAttempts &&
    a.maxAgeMs === b.maxAgeMs &&
    (a.delaysMs === undefined) === (b.delaysMs === undefined) &&
    (a.delaysMs ?? []).join() === (b.delaysMs ?? []).join()
  );
}

function assertMaxAttempts(value: number, name: string): void {
  if (value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value >= 1)) return;
  throw new Error(`EventConsumer: ${name} must be an integer of at least 1, or Infinity`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
