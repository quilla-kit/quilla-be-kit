import type { PersistenceMapper } from './mapper.interface.js';

/**
 * Abstract base for `PersistenceMapper` implementations. Handles
 * bidirectional row↔aggregate conversion via prototype reflection:
 *
 * - **On write**, the aggregate's prototype chain is walked for every
 *   accessor that has BOTH `get` and `set` — those are the persisted
 *   properties. Getter-only accessors (computed / derived) are excluded.
 * - **On read**, each column in the received row is reverse-mapped to a
 *   domain property name.
 * - **Name resolution** converts camelCase ↔ snake_case by default;
 *   `columnOverrides` covers any column whose domain name deviates.
 *
 * Consumers implement:
 * - `createDomain(props, id)` — reconstructs the aggregate.
 * - `createPersistence(aggregate)` — optional; serializes value objects or
 *   emits derived columns. Merged *over* the default conversion.
 * - `columnOverrides` — optional sparse map (`domainKey → columnName`).
 *
 * @example Tenant — zero-boilerplate case:
 * ```ts
 * class TenantInfraMapper extends BasePersistenceMapper<Tenant, TenantProps, TenantRow> {
 *   protected createDomain(props: TenantProps, id: string) {
 *     return Tenant.reconstitute(props, id);
 *   }
 * }
 * ```
 *
 * @example User — mixed overrides + value-object serialization:
 * ```ts
 * class UserInfraMapper extends BasePersistenceMapper<User, UserProps, UserRow> {
 *   protected override readonly columnOverrides = {
 *     password: 'password_hash',
 *     resetPasswordTokenExpiresAt: 'reset_password_token_expiration',
 *   } as const;
 *
 *   protected createDomain(props: UserProps, id: string) {
 *     return User.reconstitute({
 *       ...props,
 *       password: Password.fromHashedValue(props.password as string),
 *     }, id);
 *   }
 *
 *   protected override createPersistence(user: User): Partial<UserRow> {
 *     return { password_hash: user.password.getHashedValue() };
 *   }
 * }
 * ```
 */
export abstract class BasePersistenceMapper<TAggregate, TProps, TRow>
  implements PersistenceMapper<TAggregate, TRow>
{
  protected readonly columnOverrides: Readonly<Record<string, string>> = {};

  protected abstract createDomain(props: TProps, id: string): TAggregate;

  protected createPersistence?(aggregate: TAggregate): Partial<TRow>;

  // Lazy reverse-map cache: columnName → domainKey. Built once per instance
  // on first `toDomain`; subsequent lookups are O(1).
  private _inverseOverrides: Record<string, string> | undefined;

  toDomain(row: TRow): TAggregate {
    const rowRecord = row as Record<string, unknown>;
    const id = String(rowRecord.id ?? '');

    const props: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(rowRecord)) {
      if (column === 'id') continue;
      props[this.domainKeyFor(column)] = value;
    }

    return this.createDomain(props as TProps, id);
  }

  toPersistence(aggregate: TAggregate): TRow {
    const instance = aggregate as Record<string, unknown> & { id: string };
    const row: Record<string, unknown> = { id: instance.id };

    for (const domainKey of discoverPersistedKeys(aggregate as object)) {
      row[this.columnFor(domainKey)] = instance[domainKey];
    }

    const custom = this.createPersistence?.(aggregate) ?? {};
    return { ...row, ...custom } as TRow;
  }

  private columnFor(domainKey: string): string {
    return this.columnOverrides[domainKey] ?? camelToSnake(domainKey);
  }

  private domainKeyFor(column: string): string {
    const inverse = this._inverseOverrides ?? this.buildInverseOverrides();
    return inverse[column] ?? snakeToCamel(column);
  }

  private buildInverseOverrides(): Record<string, string> {
    const inverse: Record<string, string> = {};
    for (const [domainKey, columnName] of Object.entries(this.columnOverrides)) {
      inverse[columnName] = domainKey;
    }
    this._inverseOverrides = inverse;
    return inverse;
  }
}

// Persisted-keys cache keyed by the aggregate's prototype. Prototypes are
// immutable post class-definition, so the result is stable for the process
// lifetime. WeakMap lets prototypes be GC'd if a class is ever discarded.
const persistedKeysCache = new WeakMap<object, readonly string[]>();

function discoverPersistedKeys(instance: object): readonly string[] {
  const proto = Object.getPrototypeOf(instance) as object | null;
  if (!proto) return [];
  const cached = persistedKeysCache.get(proto);
  if (cached) return cached;

  const keys = new Set<string>();
  let current: object | null = proto;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name === 'constructor' || name === 'id') continue;
      const desc = Object.getOwnPropertyDescriptor(current, name);
      if (desc && typeof desc.get === 'function' && typeof desc.set === 'function') {
        keys.add(name);
      }
    }
    current = Object.getPrototypeOf(current);
  }
  const result: readonly string[] = [...keys];
  persistedKeysCache.set(proto, result);
  return result;
}

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
