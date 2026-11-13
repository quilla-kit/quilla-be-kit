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
import type {
  DeliveryBacklog,
  DeliveryEntry,
  DeliveryMove,
  DeliveryPair,
  NewDelivery,
} from './delivery-entry.type.js';
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
import type { PrepareResult } from './prepare.result.js';
import { type RetryPolicy, type RetrySchedule, nextAttemptAt } from './retry.policy.js';
import type { StandardSchemaV1 } from './standard-schema.type.js';
import {
  type MemberRegistration,
  type OnHandler,
  SubscriberBuilder,
} from './subscriber.builder.js';
import type {
  PermanentFailurePredicate,
  SubscriberIdentity,
  SubscriberPolicy,
} from './subscriber.policy.js';

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
  readonly member: string;
  readonly eventType: string;
};

/** Options of `consumer.on(...)`: `key` makes the handler a member of that subscriber. */
export type HandlerOptions = Pick<
  EventSubscription<unknown>,
  'key' | 'member' | 'retry' | 'previousKeys'
>;

type RegisterOptions = Omit<MemberRegistration, 'key'> & { readonly key?: string | undefined };

type SubscriberState = {
  policy: SubscriberPolicy;
  readonly members: Registration[];
  readonly previousKeys: Set<string>;
};

/** One subscriber as `consumer.subscribers` lists it. */
export type SubscriberInfo = {
  readonly key: string;
  readonly policy: SubscriberPolicy;
  readonly members: readonly { readonly member: string; readonly eventType: string }[];
};

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
  readonly member?: string | undefined;
};

/**
 * Passed to `onFailed`: `permanent` failures are dead-lettered on the first attempt. `held`:
 * this dead letter keeps its lane blocked. `stuck`: the work has reached its subscriber's
 * `stuckAfterAttempts` (reported on every attempt from then on).
 */
export type EventFailureInfo = EventProcessedInfo & {
  readonly permanent: boolean;
  readonly held: boolean;
  readonly stuck: boolean;
};

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
  /** Default of each subscriber's `stuckAfterAttempts` (see `EventFailureInfo.stuck`). */
  readonly stuckAfterAttempts?: number;
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
  readonly isPermanentFailure?: PermanentFailurePredicate;
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
  private readonly stuckAfterAttempts: number | undefined;
  private readonly subscriberStates = new Map<string, SubscriberState>();
  // Earlier member identities (`{ key, member }` previousKeys), by the identity they name.
  private readonly renames = new Map<string, DeliveryMove>();
  private deliveryPairs: readonly DeliveryPair[] = [];
  readonly on: OnHandler<this, HandlerOptions>;
  private ready: Promise<PrepareResult> | undefined;

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
    if (options.stuckAfterAttempts !== undefined) {
      assertMaxAttempts(options.stuckAfterAttempts, 'stuckAfterAttempts');
    }
    this.stuckAfterAttempts = options.stuckAfterAttempts;
    this.on = ((
      target: string | EventDescriptor<unknown>,
      handler: EventHandler,
      handlerOptions?: HandlerOptions & { readonly requires?: ContextRequirement | undefined },
    ) => this.register(target, handler, handlerOptions ?? {})) as OnHandler<this, HandlerOptions>;
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

  /** The registered subscribers, their policies and members (for fence tests). */
  get subscribers(): readonly SubscriberInfo[] {
    return [...this.subscriberStates].map(([key, state]) => ({
      key,
      policy: { ...state.policy, previousKeys: [...state.previousKeys] },
      members: state.members.map((m) => ({ member: m.member, eventType: m.eventType })),
    }));
  }

  /**
   * Declares a subscriber: one key, one policy and one lane per aggregate, shared by the
   * handlers registered on the returned builder.
   */
  subscriber(key: string, policy: SubscriberPolicy = {}): SubscriberBuilder {
    this.mergePolicy(key, policy);
    return new SubscriberBuilder(key, (target, handler, registration) => {
      this.register(target, handler, registration);
    });
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
    { requires, key, member, retry, previousKeys }: RegisterOptions,
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
    const registration: Registration = {
      handler: wrapped,
      requires,
      key,
      member: member ?? eventType,
      eventType,
    };
    const registrations = [...(this.handlers.get(eventType) ?? []), registration];
    this.assertKeys(eventType, registrations);
    if (key !== undefined) this.addMember(key, registration, retry, previousKeys);
    this.handlers.set(eventType, registrations);
    if (isNewType) this.topicKeys = [...this.handlers.keys()];
    return this;
  }

  private addMember(
    key: string,
    registration: Registration,
    retry: RetryPolicy | undefined,
    previousKeys: readonly (string | SubscriberIdentity)[] | undefined,
  ): void {
    const oldKeys: string[] = [];
    const identities: SubscriberIdentity[] = [];
    for (const p of previousKeys ?? []) {
      if (typeof p === 'string') oldKeys.push(p);
      else identities.push(p);
    }
    const state = this.mergePolicy(key, { retry, previousKeys: oldKeys });
    if (this.memberOf({ key, member: registration.member })) {
      throw new Error(
        `EventConsumer: subscriber "${key}" already has a member "${registration.member}"; give one of them its own \`member\` name`,
      );
    }
    const to = { key, member: registration.member };
    for (const from of identities) {
      const id = identityKey(from);
      if (id === identityKey(to)) {
        throw new Error(`EventConsumer: "${key}/${to.member}" lists itself in previousKeys`);
      }
      const existing = this.renames.get(id);
      if (existing && identityKey(existing.to) !== identityKey(to)) {
        throw new Error(
          `EventConsumer: "${from.key}/${from.member}" is listed in previousKeys of two members`,
        );
      }
      this.renames.set(id, { from, to });
    }
    state.members.push(registration);
    this.deliveryPairs = [...this.deliveryPairs, { ...to, eventType: registration.eventType }];
  }

  // One policy per subscriber, whichever registration gives it.
  private mergePolicy(key: string, incoming: SubscriberPolicy): SubscriberState {
    let state = this.subscriberStates.get(key);
    if (!state) {
      state = { policy: {}, members: [], previousKeys: new Set() };
      this.subscriberStates.set(key, state);
    }
    const current = state.policy;
    const conflict = (field: string) =>
      new Error(`EventConsumer: subscriber "${key}" was given two different \`${field}\` values`);
    const { retry, deadLetter, isPermanentFailure, stuckAfterAttempts } = incoming;
    if (retry?.maxAttempts !== undefined) {
      assertMaxAttempts(retry.maxAttempts, `retry.maxAttempts of "${key}"`);
    }
    if (retry && current.retry && !samePolicy(current.retry, retry)) throw conflict('retry');
    if (deadLetter === 'hold' && !this.isolated) {
      throw new Error(
        `EventConsumer: subscriber "${key}" holds its lanes on dead-letter, which needs \`isolation\``,
      );
    }
    if (deadLetter && current.deadLetter && current.deadLetter !== deadLetter) {
      throw conflict('deadLetter');
    }
    // Functions can't be compared for equivalence, so a predicate is given once per key.
    if (isPermanentFailure && current.isPermanentFailure) throw conflict('isPermanentFailure');
    if (stuckAfterAttempts !== undefined) {
      assertMaxAttempts(stuckAfterAttempts, `stuckAfterAttempts of "${key}"`);
      if (
        current.stuckAfterAttempts !== undefined &&
        current.stuckAfterAttempts !== stuckAfterAttempts
      ) {
        throw conflict('stuckAfterAttempts');
      }
    }
    for (const previous of incoming.previousKeys ?? []) {
      if (previous === key) {
        throw new Error(`EventConsumer: subscriber "${key}" lists itself in previousKeys`);
      }
      state.previousKeys.add(previous);
    }
    state.policy = {
      retry: retry ?? current.retry,
      deadLetter: deadLetter ?? current.deadLetter,
      isPermanentFailure: isPermanentFailure ?? current.isPermanentFailure,
      stuckAfterAttempts: stuckAfterAttempts ?? current.stuckAfterAttempts,
    };
    return state;
  }

  start(): void {
    if (this.loops.length > 0) return;
    this.assertRenames();
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
      if (isolated && !(await this.prepared())) return;
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
        queued.push({
          handlerKey: key,
          member: registration.member,
          status: 'PENDING',
          retryCount: 0,
        });
        continue;
      }
      const failure = await this.execute(event, fields, registration);
      if (!failure) continue;
      if (failure.permanent) permanent.add(identityKey({ key, member: registration.member }));
      queued.push(this.firstFailure(registration, failure, event));
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
      if (
        event.aggregateId !== undefined &&
        (delivery.status === 'PENDING' || delivery.holdsLane)
      ) {
        lanes.add(laneKey(delivery.handlerKey, event.aggregateId));
      }
    }
    for (const delivery of created) {
      if (delivery.retryCount === 0) continue;
      const id = identityKey({ key: delivery.handlerKey, member: delivery.member });
      this.reportDeliveryFailure(delivery, permanent.has(id));
    }
  }

  private firstFailure(
    registration: Registration,
    failure: HandlerFailure,
    event: EventBusEntry,
  ): NewDelivery {
    const key = registration.key ?? '';
    const base = {
      handlerKey: key,
      member: registration.member,
      retryCount: 1,
      lastError: failure.message,
      lastFailedBy: this.instanceId,
    };
    const now = new Date();
    const next = failure.permanent ? undefined : nextAttemptAt(this.scheduleFor(key), 0, now, now);
    return next
      ? { ...base, status: 'PENDING', nextAttemptAt: next }
      : { ...base, status: 'FAILED', holdsLane: this.holdsLane(key, event) };
  }

  // Only work with an aggregate has a lane to hold.
  private holdsLane(key: string, entry: EventBusEntry): boolean {
    return (
      this.subscriberStates.get(key)?.policy.deadLetter === 'hold' &&
      entry.aggregateId !== undefined
    );
  }

  private stuckAfter(key: string | undefined): number {
    const own = key === undefined ? undefined : this.subscriberStates.get(key)?.policy;
    return own?.stuckAfterAttempts ?? this.stuckAfterAttempts ?? Number.POSITIVE_INFINITY;
  }

  private reportDeliveryFailure(delivery: DeliveryEntry, permanent: boolean): void {
    const info = {
      permanent,
      source: 'delivery',
      handlerKey: delivery.handlerKey,
      member: delivery.member,
      held: delivery.holdsLane,
      stuck: delivery.retryCount >= this.stuckAfter(delivery.handlerKey),
    } as const;
    this.callHook('onFailed', delivery.id, () => this.onFailed?.(delivery, info));
  }

  private async deliveryTick({ queue, leases }: DeliveryWork): Promise<void> {
    try {
      await this.sweepStale(queue);
      if (this.deliveryPairs.length === 0 || !(await this.prepared())) return;
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
        const registration = this.memberOf({ key: delivery.handlerKey, member: delivery.member });
        if (registration?.eventType !== delivery.eventType) {
          // Claims filter on registered members; a type mismatch means a previousKeys mapping
          // pointed this work at a member of another event type.
          this.logger.error('delivery claimed for a member that does not handle it', undefined, {
            meta: {
              deliveryId: delivery.id,
              handlerKey: delivery.handlerKey,
              member: delivery.member,
              eventType: delivery.eventType,
            },
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
        this.onProcessed?.(delivery, {
          source: 'delivery',
          handlerKey: key,
          member: delivery.member,
        }),
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
        : queue.markFailedPermanently(delivery.id, failure.message, this.instanceId, {
            holdLane: this.holdsLane(key, delivery),
          }),
    );
    if (failed) this.reportDeliveryFailure(failed, failure.permanent);
  }

  private scheduleFor(key: string): RetrySchedule {
    const policy = this.subscriberStates.get(key)?.policy.retry;
    const delaysMs = policy?.delaysMs ?? this.retryDelaysMs;
    return {
      delaysMs,
      maxAttempts: policy?.maxAttempts ?? this.maxAttempts ?? delaysMs.length + 1,
      maxAgeMs: policy?.maxAgeMs,
    };
  }

  /**
   * Prepares the deliveries before any dispatch: moves renamed subscribers' work to their
   * current identity (`previousKeys`), then reports work this consumer can't run. Runs once per
   * process; `start()` runs it on its own when not awaited here. Rejects when the queue can't be
   * reached, or when `previousKeys` names a registered subscriber.
   */
  async prepare(): Promise<PrepareResult> {
    const queue = this.delivery?.queue;
    if (!queue) {
      this.assertRenames();
      return { moved: 0, superseded: 0, unregistered: [], staleHolds: [] };
    }
    this.ready ??= this.runPrepare(queue).catch((err: unknown) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  // For the poll loops: a failed preparation is retried on the next tick.
  private async prepared(): Promise<boolean> {
    try {
      await this.prepare();
      return true;
    } catch (err) {
      this.logger.error('preparing deliveries failed; will retry', err);
      return false;
    }
  }

  private async runPrepare(queue: DeliveryQueue): Promise<PrepareResult> {
    this.assertRenames();
    const moves = this.renameMoves();
    const { moved, superseded } =
      moves.length > 0 ? await queue.rekey(this.consumerName, moves) : { moved: 0, superseded: 0 };
    if (moved > 0 || superseded > 0) {
      this.logger.info(`moved ${moved} queued deliveries to renamed subscribers`, {
        meta: { moved, superseded },
      });
    }
    const unregistered: DeliveryBacklog[] = [];
    const staleHolds: DeliveryBacklog[] = [];
    for (const backlog of await queue.backlog(this.consumerName)) {
      const state = this.subscriberStates.get(backlog.handlerKey);
      if (!state || !this.memberOf({ key: backlog.handlerKey, member: backlog.member })) {
        unregistered.push(backlog);
        this.reportUnregistered(backlog);
      } else if (backlog.held > 0 && (!this.isolated || state.policy.deadLetter !== 'hold')) {
        staleHolds.push(backlog);
        this.logger.warn(
          `${backlog.held} dead deliveries of "${backlog.handlerKey}/${backlog.member}" still hold their lanes, though the subscriber no longer holds; release them with releaseHold`,
          { meta: { ...backlog } },
        );
      }
    }
    return { moved, superseded, unregistered, staleHolds };
  }

  // Earlier keys move member by member; an exact earlier identity wins over its key's move.
  private renameMoves(): DeliveryMove[] {
    const moves = new Map<string, DeliveryMove>();
    for (const [key, state] of this.subscriberStates) {
      for (const previous of state.previousKeys) {
        for (const { member } of state.members) {
          const from = { key: previous, member };
          moves.set(identityKey(from), { from, to: { key, member } });
        }
      }
    }
    for (const [id, move] of this.renames) moves.set(id, move);
    return [...moves.values()];
  }

  private memberOf({ key, member }: SubscriberIdentity): Registration | undefined {
    return this.subscriberStates.get(key)?.members.find((m) => m.member === member);
  }

  // A rename must not take work from a subscriber that is still registered.
  private assertRenames(): void {
    for (const [key, state] of this.subscriberStates) {
      for (const previous of state.previousKeys) {
        if (this.subscriberStates.has(previous)) {
          throw new Error(
            `EventConsumer: "${key}" lists "${previous}" in previousKeys, but "${previous}" is still a registered subscriber`,
          );
        }
      }
    }
    for (const { from } of this.renames.values()) {
      if (this.memberOf(from)) {
        throw new Error(
          `EventConsumer: previousKeys names "${from.key}/${from.member}", which is still registered`,
        );
      }
    }
  }

  private reportUnregistered(backlog: DeliveryBacklog): void {
    const { handlerKey, member, lanes } = backlog;
    const message = `deliveries belong to "${handlerKey}/${member}", which this consumer doesn't register; map it with previousKeys or discard them`;
    if (lanes > 0) {
      this.logger.error(`${message} (${lanes} lane(s) stay blocked until then)`, undefined, {
        meta: { ...backlog },
      });
    } else {
      this.logger.warn(message, { meta: { ...backlog } });
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
    const failingKeys: (string | undefined)[] = [];
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
      if (failure) {
        failures.push(failure);
        failingKeys.push(registration.key);
      }
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
      const stuckAfter = Math.min(...failingKeys.map((k) => this.stuckAfter(k)));
      const info = {
        permanent,
        source: 'event',
        held: false,
        stuck: failed.retryCount >= stuckAfter,
      } as const;
      this.callHook('onFailed', event.id, () => this.onFailed?.(failed, info));
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
      // Members are unique per (key, member); the outcome ledger only knows the key.
      if (!this.tracks(registrations)) continue;
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
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    };
  }

  // One attempt per claim: a retry is a later claim, possibly on another instance.
  private async execute(
    event: EventBusEntry,
    fields: HandlerEntryFields,
    { handler, requires, key, member }: Registration,
  ): Promise<HandlerFailure | undefined> {
    const meta = {
      eventId: event.id,
      eventType: event.eventType,
      attempt: event.retryCount + 1,
      ...(key !== undefined ? { handlerKey: key, member } : {}),
    };
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
      if (this.isPermanent(err, event, meta, key)) {
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
    key: string | undefined,
  ): boolean {
    if (
      err instanceof SchemaValidationError ||
      MissingScopeError.is(err) ||
      MissingSessionError.is(err)
    ) {
      return true;
    }
    const classify =
      (key !== undefined ? this.subscriberStates.get(key)?.policy.isPermanentFailure : undefined) ??
      this.isPermanentFailure;
    if (!classify) return false;
    try {
      return classify(err, { entry });
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

function identityKey({ key, member }: SubscriberIdentity): string {
  return `${key}\0${member}`;
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
