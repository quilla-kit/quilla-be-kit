import type { ActorType } from '../actors/actor.type.js';

export enum EventKind {
  DOMAIN = 'domain',
  INTEGRATION = 'integration',
}

export type ActorAttributes = Readonly<Record<string, string | number | boolean>>;

export const RESERVED_ACTOR_ATTRIBUTE_KEYS: readonly string[] = [
  'scopeId',
  'userId',
  '__proto__',
  'constructor',
  'prototype',
];

export type EventMetadataProps = {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId?: string;
  readonly userId?: string;
  /** App-defined facts about the actor beyond `scopeId`/`userId`. Requires both. */
  readonly actorAttributes?: ActorAttributes;
  /** The scope this operation crossed in from. Attribution only, never an authorization input. */
  readonly crossedFrom?: string;
  readonly createdAt?: Date;
};

export type EventMetadataJSON = {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | null;
  readonly userId: string | null;
  readonly actorAttributes?: ActorAttributes;
  readonly crossedFrom?: string;
  readonly createdAt: string;
};

export class EventMetadata {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | undefined;
  readonly userId: string | undefined;
  readonly actorAttributes: ActorAttributes | undefined;
  readonly crossedFrom: string | undefined;
  readonly createdAt: Date;

  private constructor(props: EventMetadataProps) {
    this.kind = props.kind;
    this.correlationId = props.correlationId;
    this.actorType = props.actorType;
    this.scopeId = props.scopeId;
    this.userId = props.userId;
    this.actorAttributes = props.actorAttributes
      ? Object.freeze({ ...props.actorAttributes })
      : undefined;
    this.crossedFrom = props.crossedFrom;
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: EventMetadataProps): EventMetadata {
    const attributes = props.actorAttributes;
    if (attributes) {
      if (props.scopeId === undefined || props.userId === undefined) {
        throw new Error('EventMetadata: actorAttributes require both scopeId and userId');
      }
      const reserved = Object.keys(attributes).filter((k) =>
        RESERVED_ACTOR_ATTRIBUTE_KEYS.includes(k),
      );
      if (reserved.length > 0) {
        throw new Error(`EventMetadata: reserved actorAttributes key(s): ${reserved.join(', ')}`);
      }
    }
    if (props.crossedFrom !== undefined) {
      if (props.scopeId === undefined) {
        throw new Error('EventMetadata: crossedFrom requires scopeId');
      }
      if (props.crossedFrom === props.scopeId) {
        throw new Error('EventMetadata: crossedFrom must differ from scopeId');
      }
    }
    return new EventMetadata(props);
  }

  toJSON(): EventMetadataJSON {
    return {
      kind: this.kind,
      correlationId: this.correlationId,
      actorType: this.actorType,
      scopeId: this.scopeId ?? null,
      userId: this.userId ?? null,
      ...(this.actorAttributes ? { actorAttributes: this.actorAttributes } : {}),
      ...(this.crossedFrom !== undefined ? { crossedFrom: this.crossedFrom } : {}),
      createdAt: this.createdAt.toISOString(),
    };
  }
}
