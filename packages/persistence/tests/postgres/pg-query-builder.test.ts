import { describe, expect, it } from 'vitest';
import { PgSqlQueryBuilder } from '../../src/postgres/pg-query-builder.js';
import { DefaultColumnResolver } from '../../src/query/default.resolver.js';

const resolver = new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } });
const qb = () => new PgSqlQueryBuilder(resolver);

describe('PgSqlQueryBuilder — select + from', () => {
  it('defaults to SELECT * when no columns given', () => {
    const q = qb().from('users').build();
    expect(q.sql).toBe('SELECT * FROM users');
    expect(q.params).toEqual([]);
  });

  it('auto-aliases camelCase columns back to the domain key', () => {
    const q = qb().select(['id', 'createdAt', 'isActive']).from('users').build();
    expect(q.sql).toBe('SELECT id, created_at AS "createdAt", is_active AS "isActive" FROM users');
  });

  it('passes through qualified identifiers and pre-aliased expressions', () => {
    const q = qb().select(['u.id', 'count(*) AS "total"', 'users.*']).from('users u').build();
    expect(q.sql.startsWith('SELECT u.id, count(*) AS "total", users.* FROM users u')).toBe(true);
  });

  it('rejects injection-shaped column names', () => {
    expect(() => qb().select(['id; DROP TABLE users']).from('users').build()).toThrow(
      /invalid column/,
    );
  });

  it('rejects invalid table identifiers', () => {
    expect(() => qb().from('users; DROP').build()).toThrow(/invalid identifier/);
  });
});

describe('PgSqlQueryBuilder — filters (suffix DSL)', () => {
  it('emits equality for bare keys', () => {
    const q = qb().from('users').filters({ id: 'abc', isActive: true }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE id = $1 AND is_active = $2');
    expect(q.params).toEqual(['abc', true]);
  });

  it('resolves scopeId to tenant_id via the resolver', () => {
    const q = qb().from('users').filters({ scopeId: 't1' }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE tenant_id = $1');
    expect(q.params).toEqual(['t1']);
  });

  it('drops undefined filter values', () => {
    const q = qb().from('users').filters({ id: 'x', name: undefined }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(q.params).toEqual(['x']);
  });

  it('expands contains to ILIKE', () => {
    const q = qb().from('users').filters({ name__contains: 'Ada' }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE name ILIKE $1');
    expect(q.params).toEqual(['%Ada%']);
  });

  it('expands in / notIn to ANY / ALL', () => {
    const q = qb()
      .from('users')
      .filters({ id__in: ['a', 'b'], id__notIn: ['c'] })
      .build();
    expect(q.sql).toBe('SELECT * FROM users WHERE id = ANY($1) AND (id <> ALL($2) OR id IS NULL)');
    expect(q.params).toEqual([['a', 'b'], ['c']]);
  });

  it('expands comparators', () => {
    const d = new Date('2026-01-01');
    const q = qb().from('users').filters({ createdAt__gte: d, createdAt__lt: d }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE created_at >= $1 AND created_at < $2');
    expect(q.params).toEqual([d, d]);
  });

  it('expands isNull / isNotNull', () => {
    const q1 = qb().from('users').filters({ deletedAt__isNull: true }).build();
    expect(q1.sql).toBe('SELECT * FROM users WHERE deleted_at IS NULL');

    const q2 = qb().from('users').filters({ deletedAt__isNull: false }).build();
    expect(q2.sql).toBe('SELECT * FROM users WHERE deleted_at IS NOT NULL');
  });

  it('treats eq with null as IS NULL', () => {
    const q = qb().from('users').filters({ deletedAt: null }).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE deleted_at IS NULL');
    expect(q.params).toEqual([]);
  });

  it('throws on unknown operator suffix', () => {
    expect(() => qb().from('users').filters({ id__smells: 'x' }).build()).toThrow(
      /unknown operator/,
    );
  });
});

describe('PgSqlQueryBuilder — raw where', () => {
  it('rebases ? placeholders alongside filters', () => {
    const q = qb()
      .from('users')
      .filters({ isActive: true })
      .where('tags @> ?::jsonb', JSON.stringify(['urgent']))
      .build();
    expect(q.sql).toBe('SELECT * FROM users WHERE is_active = $1 AND tags @> $2::jsonb');
    expect(q.params).toEqual([true, JSON.stringify(['urgent'])]);
  });

  it('allows multiple where fragments ANDed together', () => {
    const q = qb().from('users').where('a > ?', 1).where('b < ?', 2).build();
    expect(q.sql).toBe('SELECT * FROM users WHERE a > $1 AND b < $2');
    expect(q.params).toEqual([1, 2]);
  });

  it('throws on mismatched ? placeholders', () => {
    expect(() => qb().from('users').where('a = ? AND b = ?', 1).build()).toThrow();
    expect(() => qb().from('users').where('a = ?', 1, 2).build()).toThrow();
  });
});

describe('PgSqlQueryBuilder — orderBy', () => {
  it('resolves sort keys and emits direction', () => {
    const q = qb()
      .from('users')
      .orderBy([{ createdAt: 'desc' }, { id: 'asc' }])
      .build();
    expect(q.sql).toBe('SELECT * FROM users ORDER BY created_at DESC, id ASC');
  });

  it('applies defaults only when user sort is empty', () => {
    const q1 = qb()
      .from('users')
      .orderBy([], { defaults: [{ createdAt: 'desc' }] })
      .build();
    expect(q1.sql).toBe('SELECT * FROM users ORDER BY created_at DESC');

    const q2 = qb()
      .from('users')
      .orderBy([{ id: 'asc' }], { defaults: [{ createdAt: 'desc' }] })
      .build();
    expect(q2.sql).toBe('SELECT * FROM users ORDER BY id ASC');
  });

  it('always prepends enforced sort before user sort', () => {
    const q = qb()
      .from('users')
      .orderBy([{ id: 'asc' }], { enforced: [{ scopeId: 'asc' }] })
      .build();
    expect(q.sql).toBe('SELECT * FROM users ORDER BY tenant_id ASC, id ASC');
  });
});

describe('PgSqlQueryBuilder — paginate', () => {
  it('emits LIMIT/OFFSET + a matching countSql', () => {
    const q = qb()
      .from('users')
      .filters({ isActive: true })
      .paginate({ page: 2, pageSize: 25 })
      .build();
    expect(q.sql).toBe('SELECT * FROM users WHERE is_active = $1 LIMIT 25 OFFSET 25');
    expect(q.countSql).toBe('SELECT COUNT(*)::bigint AS count FROM users WHERE is_active = $1');
    expect(q.params).toEqual([true]);
  });

  it('wraps GROUP BY queries in a subquery for count', () => {
    const q = qb()
      .from('users')
      .select(['scopeId'])
      .groupBy(['scopeId'])
      .paginate({ page: 1, pageSize: 10 })
      .build();
    expect(q.countSql).toContain('FROM (');
    expect(q.countSql).toContain('GROUP BY');
  });

  it('emits DISTINCT ON when requested', () => {
    const q = qb()
      .from('users')
      .paginate({ page: 1, pageSize: 10, distinctOn: ['scopeId'] })
      .build();
    expect(q.sql).toBe('SELECT DISTINCT ON (tenant_id) * FROM users LIMIT 10 OFFSET 0');
  });
});

describe('PgSqlQueryBuilder — immutability', () => {
  it('does not share state across forks', () => {
    const base = qb().from('users');
    const a = (base as PgSqlQueryBuilder).filters({ id: 'a' }).build();
    const b = (base as PgSqlQueryBuilder).filters({ id: 'b' }).build();
    expect(a.params).toEqual(['a']);
    expect(b.params).toEqual(['b']);
    expect(a.sql).toBe('SELECT * FROM users WHERE id = $1');
    expect(b.sql).toBe('SELECT * FROM users WHERE id = $1');
  });
});

describe('PgSqlQueryBuilder — build prerequisites', () => {
  it('throws when .from is missing', () => {
    expect(() => qb().select(['id']).build()).toThrow(/\.from\(table\) is required/);
  });
});
