import {
  ALL_FILTER_OPERATORS,
  FILTER_DELIMITER,
  type FilterOperator,
} from './field-descriptor.type.js';

const KNOWN_OPERATORS: ReadonlySet<FilterOperator> = new Set(ALL_FILTER_OPERATORS);

/**
 * Splits a filter key like `expiresAt__lt` into its field and operator.
 * Keys with no `__` suffix default to `eq` and report `hadSuffix: false`,
 * letting callers apply suffix-only rules (e.g. stricter field-name
 * validation) without re-deriving whether a suffix was present. Shared by
 * every dialect's query building and by the write DAOs' predicate checks,
 * so all of them use one operator vocabulary.
 */
export function parseFilterKey(rawKey: string): {
  field: string;
  operator: FilterOperator;
  hadSuffix: boolean;
} {
  const delimiterIndex = rawKey.indexOf(FILTER_DELIMITER);
  if (delimiterIndex < 0) {
    return { field: rawKey, operator: 'eq', hadSuffix: false };
  }
  const field = rawKey.slice(0, delimiterIndex);
  const opString = rawKey.slice(delimiterIndex + FILTER_DELIMITER.length);
  if (!KNOWN_OPERATORS.has(opString as FilterOperator)) {
    throw new Error(
      `unknown operator "${opString}" in key "${rawKey}". ` +
        `Known operators: ${[...KNOWN_OPERATORS].join(', ')}.`,
    );
  }
  return { field, operator: opString as FilterOperator, hadSuffix: true };
}

/**
 * Resolves the conveniences a bare key (no `__operator`) carries: a `null`
 * value means `IS NULL`, and — when `arrayAsIn` — an array value means
 * `IN`. Suffixed keys, `__eq` included, always keep their plain SQL meaning.
 */
export function filterOperator(
  parsed: { operator: FilterOperator; hadSuffix: boolean },
  value: unknown,
  arrayAsIn: boolean,
): FilterOperator {
  if (parsed.hadSuffix) return parsed.operator;
  if (value === null) return 'isNull';
  if (arrayAsIn && Array.isArray(value)) return 'in';
  return parsed.operator;
}

/** Operators whose value is a list. */
export const ARRAY_OPERATORS: ReadonlySet<FilterOperator> = new Set(['in', 'notIn', 'notInStrict']);
