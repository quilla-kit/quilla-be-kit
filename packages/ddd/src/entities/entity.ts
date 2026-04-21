import { randomUUID } from 'node:crypto';

export type EntityId = string;

export type BaseEntityProps = {
  id?: EntityId | undefined;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
  insertedBy?: string | undefined;
  updatedBy?: string | undefined;
};

/**
 * Abstract base class for DDD entities and aggregate roots.
 *
 * Subclasses must define a `private set` + `get` accessor pair for each
 * domain property that should be persisted. During construction, every
 * prop is mirrored onto `this` — firing any matching subclass setter so
 * validation/transformation runs on both initial construction and later
 * assignment.
 *
 * Computed / derived properties must declare a getter only (no setter).
 * Persistence mappers use the presence of a setter as the marker that a
 * property is persisted.
 *
 * @example
 * ```ts
 * class User extends AggregateRoot<UserProps> {
 *   // Persisted — private setter + public getter:
 *   private set firstName(v: string) { this.props.firstName = v; }
 *   get firstName(): string { return this.props.firstName; }
 *
 *   // Computed — getter only, skipped by persistence:
 *   get displayName(): string { return `${this.firstName} ${this.lastName}`; }
 * }
 * ```
 */
export abstract class Entity<TProps extends object = object> {
  private _id: EntityId;
  protected props: TProps & BaseEntityProps;

  constructor(props: TProps & BaseEntityProps, id?: EntityId) {
    this.props = props;
    this._id = id ?? props.id ?? randomUUID();

    const proto = Object.getPrototypeOf(this) as object | null;
    for (const [key, value] of Object.entries(props)) {
      if (key === 'id') continue;
      if (isAssignable(proto, key)) {
        (this as Record<string, unknown>)[key] = value;
      }
    }
  }

  get id(): EntityId {
    return this._id;
  }

  private set createdAt(value: Date | undefined) {
    this.props.createdAt = value;
  }
  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }

  protected set updatedAt(value: Date | undefined) {
    this.props.updatedAt = value;
  }
  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }

  private set insertedBy(value: string | undefined) {
    this.props.insertedBy = value;
  }
  get insertedBy(): string | undefined {
    return this.props.insertedBy;
  }

  private set updatedBy(value: string | undefined) {
    this.props.updatedBy = value;
  }
  get updatedBy(): string | undefined {
    return this.props.updatedBy;
  }

  equals(other: Entity<TProps>): boolean {
    return this._id === other._id;
  }
}

// Cache per-(prototype, key) the answer to "can I assign this key on
// an instance without hitting a setter-less accessor?" Result: `false` if
// the prototype chain has a get-only accessor for `key` (skip assignment);
// `true` otherwise (assignment fires setter, or creates own property).
// Prototypes are immutable after class definition, so this cache is safe
// for process lifetime; WeakMap lets classes be GC'd.
const assignabilityCache = new WeakMap<object, Map<string, boolean>>();

function isAssignable(proto: object | null, key: string): boolean {
  if (!proto) return true;
  let perKey = assignabilityCache.get(proto);
  if (perKey) {
    const cached = perKey.get(key);
    if (cached !== undefined) return cached;
  } else {
    perKey = new Map();
    assignabilityCache.set(proto, perKey);
  }

  let current: object | null = proto;
  let assignable = true;
  while (current && current !== Object.prototype) {
    const desc = Object.getOwnPropertyDescriptor(current, key);
    if (desc) {
      assignable = !(desc.get && !desc.set);
      break;
    }
    current = Object.getPrototypeOf(current);
  }
  perKey.set(key, assignable);
  return assignable;
}
