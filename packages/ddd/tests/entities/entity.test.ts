import { describe, expect, it } from 'vitest';
import { Entity } from '../../src/entities/entity.js';

interface FooProps {
  readonly name: string;
}

class Foo extends Entity<FooProps> {
  get name(): string {
    return this.props.name;
  }
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Entity', () => {
  it('generates a UUID when no id is provided', () => {
    expect(new Foo({ name: 'a' }).id).toMatch(UUID_V4);
  });

  it('uses the constructor id argument when provided', () => {
    expect(new Foo({ name: 'a' }, 'fixed').id).toBe('fixed');
  });

  it('falls back to props.id when constructor id is absent', () => {
    expect(new Foo({ name: 'a', id: 'from-props' }).id).toBe('from-props');
  });

  it('prefers the constructor id over props.id', () => {
    expect(new Foo({ name: 'a', id: 'from-props' }, 'fixed').id).toBe('fixed');
  });

  it('compares by id regardless of other props', () => {
    const a = new Foo({ name: 'a' }, 'shared');
    const b = new Foo({ name: 'different' }, 'shared');
    const c = new Foo({ name: 'a' }, 'other');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('exposes audit metadata from props', () => {
    const when = new Date('2026-04-20T00:00:00.000Z');
    const foo = new Foo({
      name: 'a',
      createdAt: when,
      updatedAt: when,
      insertedBy: 'actor-1',
      updatedBy: 'actor-2',
    });
    expect(foo.createdAt).toBe(when);
    expect(foo.updatedAt).toBe(when);
    expect(foo.insertedBy).toBe('actor-1');
    expect(foo.updatedBy).toBe('actor-2');
  });

  it('reports audit fields as undefined when omitted', () => {
    const foo = new Foo({ name: 'a' });
    expect(foo.createdAt).toBeUndefined();
    expect(foo.updatedAt).toBeUndefined();
    expect(foo.insertedBy).toBeUndefined();
    expect(foo.updatedBy).toBeUndefined();
  });
});
