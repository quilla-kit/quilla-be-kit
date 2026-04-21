import { AggregateRoot } from '@quilla-kit/ddd';
import { describe, expect, it } from 'vitest';
import { BasePersistenceMapper } from '../../src/repository/base-persistence.mapper.js';

// --------------------------------------------------------------------------
// Fixtures — a "Tenant" aggregate with pure camelCase↔snake_case mapping.
// --------------------------------------------------------------------------

type TenantProps = {
  name: string;
  country: string;
  adminEmail: string;
  adminFirstName: string;
};

type TenantRow = {
  id: string;
  name: string;
  country: string;
  admin_email: string;
  admin_first_name: string;
  created_at?: Date;
  updated_at?: Date;
  inserted_by?: string;
  updated_by?: string;
};

class Tenant extends AggregateRoot<TenantProps> {
  static reconstitute(props: TenantProps, id: string): Tenant {
    return new Tenant(props, id);
  }

  private set name(v: string) {
    this.props.name = v;
  }
  get name(): string {
    return this.props.name;
  }

  private set country(v: string) {
    this.props.country = v;
  }
  get country(): string {
    return this.props.country;
  }

  private set adminEmail(v: string) {
    this.props.adminEmail = v;
  }
  get adminEmail(): string {
    return this.props.adminEmail;
  }

  private set adminFirstName(v: string) {
    this.props.adminFirstName = v;
  }
  get adminFirstName(): string {
    return this.props.adminFirstName;
  }

  // Computed — getter only; must NOT appear in persistence output.
  get displayName(): string {
    return `${this.name} (${this.country})`;
  }
}

class TenantMapper extends BasePersistenceMapper<Tenant, TenantProps, TenantRow> {
  protected createDomain(props: TenantProps, id: string): Tenant {
    return Tenant.reconstitute(props, id);
  }
}

// --------------------------------------------------------------------------
// Fixtures — a "User" aggregate exercising columnOverrides + createPersistence.
// --------------------------------------------------------------------------

class Password {
  private constructor(private readonly hash: string) {}
  static fromHashed(hash: string): Password {
    return new Password(hash);
  }
  getHashedValue(): string {
    return this.hash;
  }
}

type UserPersistenceProps = {
  firstName: string;
  email: string;
  password: Password;
  resetPasswordTokenExpiresAt: Date | null;
};

type UserRow = {
  id: string;
  first_name: string;
  email: string;
  password_hash: string;
  reset_password_token_expiration: Date | null;
  created_at?: Date;
  updated_at?: Date;
  inserted_by?: string;
  updated_by?: string;
};

class User extends AggregateRoot<UserPersistenceProps> {
  static reconstitute(props: UserPersistenceProps, id: string): User {
    return new User(props, id);
  }

  private set firstName(v: string) {
    this.props.firstName = v;
  }
  get firstName(): string {
    return this.props.firstName;
  }

  private set email(v: string) {
    this.props.email = v;
  }
  get email(): string {
    return this.props.email;
  }

  private set password(v: Password) {
    this.props.password = v;
  }
  get password(): Password {
    return this.props.password;
  }

  private set resetPasswordTokenExpiresAt(v: Date | null) {
    this.props.resetPasswordTokenExpiresAt = v;
  }
  get resetPasswordTokenExpiresAt(): Date | null {
    return this.props.resetPasswordTokenExpiresAt;
  }
}

class UserMapper extends BasePersistenceMapper<User, UserPersistenceProps, UserRow> {
  protected override readonly columnOverrides = {
    password: 'password_hash',
    resetPasswordTokenExpiresAt: 'reset_password_token_expiration',
  } as const;

  protected createDomain(props: UserPersistenceProps, id: string): User {
    // `password` arrives as the raw hash string from the DB — wrap it.
    const rawPassword = props.password as unknown as string;
    return User.reconstitute(
      {
        ...props,
        password: Password.fromHashed(rawPassword),
      },
      id,
    );
  }

  protected override createPersistence(user: User): Partial<UserRow> {
    return {
      password_hash: user.password.getHashedValue(),
    };
  }
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('BasePersistenceMapper — pure convention (Tenant)', () => {
  const mapper = new TenantMapper();

  describe('toPersistence', () => {
    it('converts camelCase domain keys to snake_case columns', () => {
      const tenant = Tenant.reconstitute(
        {
          name: 'Acme',
          country: 'US',
          adminEmail: 'admin@acme.io',
          adminFirstName: 'Alice',
        },
        'tenant-1',
      );

      const row = mapper.toPersistence(tenant);
      expect(row).toEqual({
        id: 'tenant-1',
        name: 'Acme',
        country: 'US',
        admin_email: 'admin@acme.io',
        admin_first_name: 'Alice',
      });
    });

    it('includes Entity base accessors (createdAt/updatedAt/etc.) via inherited setters', () => {
      const createdAt = new Date('2026-04-01T00:00:00.000Z');
      const tenant = Tenant.reconstitute(
        {
          name: 'Acme',
          country: 'US',
          adminEmail: 'admin@acme.io',
          adminFirstName: 'Alice',
          createdAt,
          updatedAt: createdAt,
          insertedBy: 'actor-1',
          updatedBy: 'actor-1',
        } as unknown as TenantProps,
        'tenant-1',
      );

      const row = mapper.toPersistence(tenant);
      expect(row.created_at).toBe(createdAt);
      expect(row.updated_at).toBe(createdAt);
      expect(row.inserted_by).toBe('actor-1');
      expect(row.updated_by).toBe('actor-1');
    });

    it('does NOT emit computed getter-only properties (e.g. displayName)', () => {
      const tenant = Tenant.reconstitute(
        {
          name: 'Acme',
          country: 'US',
          adminEmail: 'admin@acme.io',
          adminFirstName: 'Alice',
        },
        'tenant-1',
      );

      const row = mapper.toPersistence(tenant) as Record<string, unknown>;
      expect(row).not.toHaveProperty('display_name');
      expect(row).not.toHaveProperty('displayName');
    });
  });

  describe('toDomain', () => {
    it('converts snake_case columns to camelCase domain keys', () => {
      const row: TenantRow = {
        id: 'tenant-1',
        name: 'Acme',
        country: 'US',
        admin_email: 'admin@acme.io',
        admin_first_name: 'Alice',
      };

      const tenant = mapper.toDomain(row);
      expect(tenant.id).toBe('tenant-1');
      expect(tenant.name).toBe('Acme');
      expect(tenant.adminEmail).toBe('admin@acme.io');
      expect(tenant.adminFirstName).toBe('Alice');
    });

    it('round-trips — toDomain(toPersistence(x)) preserves identity', () => {
      const original = Tenant.reconstitute(
        {
          name: 'Acme',
          country: 'US',
          adminEmail: 'admin@acme.io',
          adminFirstName: 'Alice',
        },
        'tenant-1',
      );

      const roundTripped = mapper.toDomain(mapper.toPersistence(original));
      expect(roundTripped.id).toBe(original.id);
      expect(roundTripped.name).toBe(original.name);
      expect(roundTripped.adminEmail).toBe(original.adminEmail);
    });
  });
});

describe('BasePersistenceMapper — overrides + createPersistence (User)', () => {
  const mapper = new UserMapper();

  describe('toPersistence', () => {
    it('uses columnOverrides for non-conventional names', () => {
      const user = User.reconstitute(
        {
          firstName: 'Alice',
          email: 'alice@example.com',
          password: Password.fromHashed('HASHED_XYZ'),
          resetPasswordTokenExpiresAt: null,
        },
        'user-1',
      );

      const row = mapper.toPersistence(user);
      // Overridden column names:
      expect(row).toHaveProperty('reset_password_token_expiration', null);
      expect(row).toHaveProperty('password_hash', 'HASHED_XYZ');
      // NOT the default snake_case:
      const rowAsRecord = row as Record<string, unknown>;
      expect(rowAsRecord).not.toHaveProperty('password');
      expect(rowAsRecord).not.toHaveProperty('reset_password_token_expires_at');
    });

    it('createPersistence output overrides default conversion (value object → string)', () => {
      const user = User.reconstitute(
        {
          firstName: 'Alice',
          email: 'alice@example.com',
          password: Password.fromHashed('HASHED_ABC'),
          resetPasswordTokenExpiresAt: null,
        },
        'user-1',
      );

      const row = mapper.toPersistence(user);
      // password_hash is the scalar string, not the Password instance:
      expect(row.password_hash).toBe('HASHED_ABC');
      expect(typeof row.password_hash).toBe('string');
    });
  });

  describe('toDomain', () => {
    it('reverse-maps overridden columns to domain keys', () => {
      const expiresAt = new Date('2026-04-10T00:00:00.000Z');
      const row: UserRow = {
        id: 'user-1',
        first_name: 'Alice',
        email: 'alice@example.com',
        password_hash: 'HASHED_XYZ',
        reset_password_token_expiration: expiresAt,
      };

      const user = mapper.toDomain(row);
      expect(user.firstName).toBe('Alice');
      expect(user.email).toBe('alice@example.com');
      expect(user.password.getHashedValue()).toBe('HASHED_XYZ');
      expect(user.resetPasswordTokenExpiresAt).toBe(expiresAt);
    });
  });
});
