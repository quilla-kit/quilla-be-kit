import { z } from 'zod';
import { FILTER_DELIMITER, OPERATORS_BY_KIND } from '../query/field-descriptor.type.js';
import type { PaginationOptions, SortOption } from '../query/list-query.type.js';
import type { StandardListQuery } from '../query/list-query.type.js';
import { fieldDescriptorsFromZod } from './field-descriptor-from-zod.js';

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;

export type CreateQueryParametersSchemaOptions<
  TExtra extends Record<string, unknown> = Record<string, never>,
> = {
  readonly defaultPageSize?: number;
  readonly maxPageSize?: number;
  /**
   * Strictness for client-supplied input that doesn't match the declared shape.
   *
   * - `false` (default) — tolerant. Unknown query keys are stripped; sort
   *   entries pointing at unknown fields or bad directions are dropped;
   *   non-positive / NaN page and pageSize values fall back to defaults.
   *   Appropriate for HTTP boundaries where you'd rather serve a valid
   *   response with sensible defaults than reject the request.
   * - `true` — strict. Unknown query keys, unknown sort fields, bad sort
   *   directions, and invalid page / pageSize values surface as Zod
   *   validation errors (single `ZodError` with all issues). Appropriate
   *   when the caller is trusted code (internal RPC, background jobs) or
   *   when you want to surface client bugs loudly.
   *
   * `maxPageSize` is always enforced via clamping — strict mode does not
   * reject oversized page requests (bounds enforcement ≠ validation; a
   * client asking for more data than you're willing to serve isn't
   * malformed input).
   */
  readonly strict?: boolean;
  /**
   * Extra top-level fields woven into the generated schema alongside
   * `filters` / `sort` / `pagination`. Use this for fields that belong on
   * the query envelope but aren't client-narrowable filters — typically
   * auth-derived identifiers the server populates post-validation, like
   * `scopeId` / `userId`. The keys:
   *
   * - Are declared at the top level of the generated schema (so strict
   *   mode accepts them and doesn't reject as unknown).
   * - Are **not** expanded by the suffix-operator DSL (no `scopeId__in`,
   *   no `userId__contains` exposed to clients).
   * - Pass through to the transform output at the top level — **not**
   *   nested under `filters`.
   *
   * Declare them as optional: `z.object({ scopeId: z.string().optional() })`.
   * The server (via `@ValidateRequest`'s auth-injection) populates them;
   * the generator only reserves the names.
   */
  readonly extraFields?: z.ZodObject<z.ZodRawShape>;
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
 * - enum:    __in, __notIn, __isNull, __isNotNull
 *
 * Equality is the bare key (`name=Ada`). Invalid input is silently tolerated
 * by default; opt into strict validation via `{ strict: true }`.
 */
export function createQueryParametersSchema<
  TFilters extends Record<string, unknown>,
  TExtra extends Record<string, unknown> = Record<string, never>,
>(
  filterShape: z.ZodObject<{ [K in keyof TFilters]: z.ZodType<TFilters[K]> }>,
  options: CreateQueryParametersSchemaOptions<TExtra> = {},
): z.ZodType<StandardListQuery<Partial<TFilters> & Record<string, unknown>> & Partial<TExtra>> {
  const defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const maxPageSize = options.maxPageSize ?? 200;
  const strict = options.strict ?? false;

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

  const extraShape = (options.extraFields?.shape as Record<string, z.ZodType> | undefined) ?? {};
  const extraKeys = new Set(Object.keys(extraShape));
  for (const [key, schema] of Object.entries(extraShape)) {
    if (key in rawShape) {
      throw new Error(
        `createQueryParametersSchema: extraFields key "${key}" collides with a reserved name (page, pageSize, sort) or a filter field already declared in the filter shape.`,
      );
    }
    rawShape[key] = schema instanceof z.ZodOptional ? schema : schema.optional();
  }

  const rawSchema = strict ? z.object(rawShape).strict() : z.object(rawShape).strip();

  return rawSchema.transform((raw, ctx) => {
    const filters: Record<string, unknown> = {};
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (key === 'page' || key === 'pageSize' || key === 'sort') continue;
      if (extraKeys.has(key)) {
        extras[key] = value;
      } else {
        filters[key] = value;
      }
    }

    const pagination = parsePagination(raw, defaultPageSize, maxPageSize, strict, ctx);
    const sort = parseSort(raw.sort, sortableKeys, strict, ctx);

    return {
      ...extras,
      filters,
      ...(sort.length > 0 ? { sort } : {}),
      ...(pagination ? { pagination } : {}),
    };
  }) as unknown as z.ZodType<
    StandardListQuery<Partial<TFilters> & Record<string, unknown>> & Partial<TExtra>
  >;
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
  strict: boolean,
  ctx: z.RefinementCtx,
): PaginationOptions | null {
  const hasPage = raw.page !== undefined;
  const hasPageSize = raw.pageSize !== undefined;
  if (!hasPage && !hasPageSize) return null;

  const parsedPage = hasPage ? Number.parseInt(String(raw.page), 10) : DEFAULT_PAGE;
  const parsedSize = hasPageSize ? Number.parseInt(String(raw.pageSize), 10) : defaultPageSize;

  const pageValid = Number.isFinite(parsedPage) && parsedPage > 0;
  const sizeValid = Number.isFinite(parsedSize) && parsedSize > 0;

  if (strict && hasPage && !pageValid) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid page "${String(raw.page)}"; expected a positive integer`,
      path: ['page'],
    });
  }
  if (strict && hasPageSize && !sizeValid) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid pageSize "${String(raw.pageSize)}"; expected a positive integer`,
      path: ['pageSize'],
    });
  }

  const page = pageValid ? parsedPage : DEFAULT_PAGE;
  const pageSize = sizeValid ? Math.min(parsedSize, maxPageSize) : defaultPageSize;
  return { page, pageSize };
}

function parseSort(
  value: unknown,
  sortableKeys: readonly string[],
  strict: boolean,
  ctx: z.RefinementCtx,
): SortOption[] {
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
    if (!field || !allowed.has(field)) {
      if (strict) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown sort field "${field ?? ''}"; allowed: ${sortableKeys.join(', ')}`,
          path: ['sort'],
        });
      }
      continue;
    }
    const dir = direction?.toLowerCase();
    if (dir !== 'asc' && dir !== 'desc') {
      if (strict) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid sort direction "${direction ?? ''}" for field "${field}"; expected "asc" or "desc"`,
          path: ['sort'],
        });
      }
      continue;
    }
    result.push({ [field]: dir });
  }
  return result;
}
