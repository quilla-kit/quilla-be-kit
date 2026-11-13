import type { ContextRequirement } from '@quilla-be-kit/execution-context';
import type { EventSubscription } from './event-subscription.interface.js';
import type { EventHandler, ScopedEventHandler, SessionEventHandler } from './event.consumer.js';
import type { EventDescriptor } from './event.descriptor.js';
import type { RetryPolicy } from './retry.policy.js';
import type { SubscriberIdentity } from './subscriber.policy.js';

/** `on(...)` overloads: each handler type pairs with the requirement checked before it runs. */
export interface OnHandler<TSelf, TOptions> {
  <TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: EventHandler<TPayload>,
    options?: TOptions,
  ): TSelf;
  <TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: ScopedEventHandler<TPayload>,
    options: { readonly requires: 'scope' } & TOptions,
  ): TSelf;
  <TPayload>(
    descriptor: EventDescriptor<TPayload>,
    handler: SessionEventHandler<TPayload>,
    options: { readonly requires: 'session' } & TOptions,
  ): TSelf;
  (eventType: string, handler: EventHandler, options?: TOptions): TSelf;
  (
    eventType: string,
    handler: ScopedEventHandler,
    options: { readonly requires: 'scope' } & TOptions,
  ): TSelf;
  (
    eventType: string,
    handler: SessionEventHandler,
    options: { readonly requires: 'session' } & TOptions,
  ): TSelf;
}

/** Options of a member registered through `consumer.subscriber(key)`. */
export type MemberOptions = {
  /** This handler's name within the subscriber. Default: the event type. */
  readonly member?: string | undefined;
  /** Earlier identities of this member, whose queued work moves here. */
  readonly previousKeys?: readonly SubscriberIdentity[] | undefined;
};

export type MemberRegistration = {
  readonly key: string;
  readonly member?: string | undefined;
  readonly requires?: ContextRequirement | undefined;
  readonly retry?: RetryPolicy | undefined;
  readonly previousKeys?: readonly (string | SubscriberIdentity)[] | undefined;
};

type Register = (
  target: string | EventDescriptor<unknown>,
  handler: EventHandler,
  registration: MemberRegistration,
) => void;

/** Registers the members of one subscriber: one key, one policy, one lane per aggregate. */
export class SubscriberBuilder {
  readonly key: string;
  readonly on: OnHandler<this, MemberOptions>;
  private readonly register: Register;

  constructor(key: string, register: Register) {
    this.key = key;
    this.register = register;
    this.on = ((
      target: string | EventDescriptor<unknown>,
      handler: EventHandler,
      options?: MemberOptions & { readonly requires?: ContextRequirement | undefined },
    ) => {
      this.add(target, handler, {
        key,
        member: options?.member,
        requires: options?.requires,
        previousKeys: options?.previousKeys,
      });
      return this;
    }) as OnHandler<this, MemberOptions>;
  }

  subscribe(subscriptions: ReadonlyArray<EventSubscription<unknown>>): this {
    for (const sub of subscriptions) {
      if (sub.key !== undefined && sub.key !== this.key) {
        throw new Error(
          `EventConsumer: a subscription with key "${sub.key}" can't join subscriber "${this.key}"`,
        );
      }
      // Arrow preserves `this` for class-based subscriptions — a bare method ref detaches.
      this.add(sub.descriptor, (entry) => sub.handle(entry), {
        key: this.key,
        member: sub.member,
        requires: sub.requires,
        retry: sub.retry,
        previousKeys: sub.previousKeys,
      });
    }
    return this;
  }

  private add(...[target, handler, registration]: Parameters<Register>): void {
    if (registration.previousKeys?.some((p) => typeof p === 'string')) {
      throw new Error(
        `EventConsumer: a member's previousKeys take { key, member } identities; give earlier keys of "${this.key}" to consumer.subscriber(key, { previousKeys })`,
      );
    }
    this.register(target, handler, registration);
  }
}
