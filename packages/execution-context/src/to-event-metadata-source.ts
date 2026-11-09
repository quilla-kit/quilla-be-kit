import { type EventMetadataProps, RESERVED_ACTOR_ATTRIBUTE_KEYS } from '@quilla-be-kit/ddd';
import type { ExecutionContext } from './execution-context.type.js';
import { isActorAttributeValue, pickSessionKeys } from './pick-session-keys.js';
import { effectiveCrossedFrom, resolveScopeId } from './resolve-scope-id.js';

export type ToEventMetadataSourceOptions = {
  /** Session fields carried as `actorAttributes`; non-primitive values are skipped. */
  readonly actorAttributeKeys?: readonly string[];
};

/**
 * The event metadata an emitting context should stamp; the inverse of
 * `factory.createFromEventMetadata`. Spread it into `EventMetadata.create`
 * or serialize it as the event's `metadata`.
 */
export function toEventMetadataSource(
  ctx: ExecutionContext,
  options: ToEventMetadataSourceOptions = {},
): Omit<EventMetadataProps, 'kind' | 'createdAt'> {
  const scopeId = resolveScopeId(ctx);
  const session = ctx.session;
  const crossedFrom = effectiveCrossedFrom(scopeId, ctx.crossedFrom);
  const keys = options.actorAttributeKeys?.filter(
    (k) => !RESERVED_ACTOR_ATTRIBUTE_KEYS.includes(k),
  );
  const actorAttributes =
    session && keys ? pickSessionKeys(session, keys, isActorAttributeValue) : undefined;

  return {
    actorType: ctx.actorType,
    correlationId: ctx.correlationId,
    ...(scopeId !== undefined ? { scopeId } : {}),
    ...(session ? { userId: session.userId } : {}),
    ...(actorAttributes ? { actorAttributes } : {}),
    ...(crossedFrom !== undefined ? { crossedFrom } : {}),
  };
}
