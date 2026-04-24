import { z } from 'zod';
import { FILTER_DELIMITER, OPERATORS_BY_KIND } from '../query/field-descriptor.type.js';
import type { PaginationOptions, SortOption } from '../query/list-query.type.js';
import type { StandardListQuery } from '../query/list-query.type.js';
import { fieldDescriptorsFromZod } from './field-descriptor-from-zod.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export type CreateQueryParametersSchemaOptions = {
  readonly defaultPageSize?: number;
  readonly maxPageSize?: number;
};

/**
 * Generates a Zod schema that parses and transforms HTTP query parameters
 * into a `StandardListQuery<TFilters>`. The output filter object is the
 * flat suffix-keyed dict expected by `SqlQueryBuilder.filters(...)`:
 *
 *   ?name__contains=foo&createdAt__gte=2026-01-01&sort=name:asc&page=2&pageSize=50
 *
 * becomes:
 *
 *   {
 *     filters: { name__contains: 'foo', createdAt__gte: Date },
 *     sort: [{ name: 'asc' }],
 *     pagination: { page: 2, pageSize: 50 }
 *   }
 *
 * Operators available per field kind:
 * - string:  __contains, __in, __notIn, __isNull, __isNotNull
 * - number:  __gt, __gte, __lt, __lte, __in, __notIn, __isNull, __isNotNull
 * - date:    __gt, __gte, __lt, __lte, __in, __notIn, __isNull, __isNotNull
 * - boolean: __isNull, __isNotNull
 *
 * Equality is the bare key (`name=Ada`). Unknown keys are stripped.
 */
export function createQueryParametersSchema<TFilters extends Record<string, unknown>>(
  filterShape: z.ZodObject<{ [K in keyof TFilters]: z.ZodType<TFilters[K]> }>,
  options: CreateQueryParametersSchemaOptions = {},
): z.ZodType<StandardListQuery<Partial<TFilters> & Record<string, unknown>>> {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = options.maxPageSize ?? 200;

  const descriptors = fieldDescriptorsFromZod(filterShape as unknown as z.ZodObject<z.ZodRawShape>);
  const rawShape: Record<string, z.ZodType> = {
    page: z.string().optional(),
    pageSize: z.string().optional(),
    sort: z.union([z.string(), z.array(z.string())]).optional(),
  };

  const sortableKeys: string[] = [];

  for (const [key, descriptor] of Object.entries(descriptors)) {
    const base = (filterShape.shape as Record<string, z.ZodType>)[key];
    if (!base) continue;
    rawShape[key] = base instanceof z.ZodOptional ? base : base.optional();
    sortableKeys.push(key);

    for (const op of OPERATORS_BY_KIND[descriptor.kind]) {
      const opKey = `${key}${FILTER_DELIMITER}${op}`;
      rawShape[opKey] = schemaForOperator(descriptor.kind, op);
    }
  }

  const rawSchema = z.object(rawShape).strip();

  return rawSchema.transform((raw): StandardListQuery<Record<string, unknown>> => {
    const filters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (key === 'page' || key === 'pageSize' || key === 'sort') continue;
      filters[key] = value;
    }

    const pagination = parsePagination(raw, defaultPageSize, maxPageSize);
    const sort = parseSort(raw.sort, sortableKeys);

    const result: StandardListQuery<Record<string, unknown>> = {
      filters,
      ...(sort.length > 0 ? { sort } : {}),
      ...(pagination ? { pagination } : {}),
    };
    return result;
  }) as unknown as z.ZodType<StandardListQuery<Partial<TFilters> & Record<string, unknown>>>;
}

function schemaForOperator(kind: string, operator: string): z.ZodType {
  if (operator === 'isNull' || operator === 'isNotNull') {
    return z
      .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
      .optional();
  }

  if (operator === 'in' || operator === 'notIn') {
    const elementSchema = elementSchemaFor(kind);
    return z.preprocess((v) => toStringArray(v), z.array(elementSchema)).optional();
  }

  if (operator === 'contains') {
    return z.string().optional();
  }

  // gt / gte / lt / lte — scalar of the field's kind
  return scalarSchemaFor(kind).optional();
}

function scalarSchemaFor(kind: string): z.ZodType {
  switch (kind) {
    case 'number':
      return z.coerce.number();
    case 'date':
      return z.coerce.date();
    case 'boolean':
      return z.coerce.boolean();
    default:
      return z.string();
  }
}

function elementSchemaFor(kind: string): z.ZodType {
  return scalarSchemaFor(kind);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => (typeof v === 'string' ? v.split(',') : []));
  }
  if (typeof value === 'string') {
    return value.split(',');
  }
  return [];
}

function parsePagination(
  raw: Record<string, unknown>,
  defaultPageSize: number,
  maxPageSize: number,
): PaginationOptions | null {
  const hasPage = raw.page !== undefined;
  const hasPageSize = raw.pageSize !== undefined;
  if (!hasPage && !hasPageSize) return null;

  const parsedPage = hasPage ? Number.parseInt(String(raw.page), 10) : DEFAULT_PAGE;
  const parsedSize = hasPageSize ? Number.parseInt(String(raw.pageSize), 10) : defaultPageSize;

  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : DEFAULT_PAGE;
  const pageSize =
    Number.isFinite(parsedSize) && parsedSize > 0
      ? Math.min(parsedSize, maxPageSize)
      : defaultPageSize;
  return { page, pageSize };
}

function parseSort(value: unknown, sortableKeys: readonly string[]): SortOption[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

  const allowed = new Set(sortableKeys);
  const deduped = new Set(entries.map((e) => e.trim()));
  const result: SortOption[] = [];
  for (const entry of deduped) {
    const [field, direction] = entry.split(':');
    if (!field || !allowed.has(field)) continue;
    const dir = direction?.toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') continue;
    result.push({ [field]: dir });
  }
  return result;
}
