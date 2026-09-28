import type { ActorType } from '../actors/actor.type.js';

export enum EventKind {
  DOMAIN = 'domain',
  INTEGRATION = 'integration',
}

export type ActorAttributes = Readonly<Record<string, string | number | boolean>>;

const RESERVED_ATTRIBUTE_KEYS: readonly string[] = [
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
  readonly createdAt?: Date;
};

export type EventMetadataJSON = {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | null;
  readonly userId: string | null;
  readonly actorAttributes?: ActorAttributes;
  readonly createdAt: string;
};

export class EventMetadata {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | undefined;
  readonly userId: string | undefined;
  readonly actorAttributes: ActorAttributes | undefined;
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
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: EventMetadataProps): EventMetadata {
    const attributes = props.actorAttributes;
    if (attributes) {
      if (props.scopeId === undefined || props.userId === undefined) {
        throw new Error('EventMetadata: actorAttributes require both scopeId and userId');
      }
      const reserved = Object.keys(attributes).filter((k) => RESERVED_ATTRIBUTE_KEYS.includes(k));
      if (reserved.length > 0) {
        throw new Error(`EventMetadata: reserved actorAttributes key(s): ${reserved.join(', ')}`);
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
      createdAt: this.createdAt.toISOString(),
    };
  }
}
