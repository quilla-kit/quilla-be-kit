import { describe, it } from 'vitest';
import type { FilterQuery } from '../../src/db-adapter/filter-query.type.js';

type Row = {
  id: string;
  status: string;
  expiresAt: Date;
  count: number;
  active: boolean;
  total: bigint;
  amount: string | null;
};

describe('FilterQuery<T> operator gating (compile-time)', () => {
  it('accepts operator-suffixed keys matched to their field kind', () => {
    const ok: FilterQuery<Row> = {
      status: 'PENDING',
      expiresAt__lt: new Date(),
      count__gte: 1,
      status__contains: 'PEND',
      status__in: ['PENDING', 'ACTIVE'],
      id__isNull: false,
    };
    void ok;
  });

  it('accepts comparison operators on string and bigint fields', () => {
    const ok: FilterQuery<Row> = { amount__gt: '10.50', status__lte: 'M', total__lt: 5n };
    void ok;
  });

  it('rejects comparison operators on non-comparable fields', () => {
    // @ts-expect-error - __lt is not valid on a boolean field
    const bad: FilterQuery<Row> = { active__lt: true };
    void bad;
  });

  it('accepts the strict operators, with null', () => {
    const ok: FilterQuery<Row> = {
      status__eq: 'PENDING',
      amount__eq: null,
      count__ne: 3,
      id__ne: null,
      status__notInStrict: ['DONE'],
    };
    void ok;
  });

  it('types strict values by their field', () => {
    // @ts-expect-error - count is a number
    const bad: FilterQuery<Row> = { count__eq: 'x' };
    void bad;
  });

  it('rejects __contains on a non-string field', () => {
    // @ts-expect-error - __contains is not valid on a Date field
    const bad: FilterQuery<Row> = { expiresAt__contains: 'x' };
    void bad;
  });

  it('rejects an unknown operator suffix', () => {
    // @ts-expect-error - __smells is not a known operator
    const bad: FilterQuery<Row> = { status__smells: 'x' };
    void bad;
  });
});
