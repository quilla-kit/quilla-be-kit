import type { ActorType } from '../actors/actor.type.js';

export enum EventKind {
  DOMAIN = 'domain',
  INTEGRATION = 'integration',
}

export type EventMetadataProps = {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId?: string;
  readonly userId?: string;
  readonly createdAt?: Date;
};

export type EventMetadataJSON = {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | null;
  readonly userId: string | null;
  readonly createdAt: string;
};

export class EventMetadata {
  readonly kind: EventKind;
  readonly correlationId: string;
  readonly actorType: ActorType;
  readonly scopeId: string | undefined;
  readonly userId: string | undefined;
  readonly createdAt: Date;

  private constructor(props: EventMetadataProps) {
    this.kind = props.kind;
    this.correlationId = props.correlationId;
    this.actorType = props.actorType;
    this.scopeId = props.scopeId;
    this.userId = props.userId;
    this.createdAt = props.createdAt ?? new Date();
  }

  static create(props: EventMetadataProps): EventMetadata {
    return new EventMetadata(props);
  }

  toJSON(): EventMetadataJSON {
    return {
      kind: this.kind,
      correlationId: this.correlationId,
      actorType: this.actorType,
      scopeId: this.scopeId ?? null,
      userId: this.userId ?? null,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
