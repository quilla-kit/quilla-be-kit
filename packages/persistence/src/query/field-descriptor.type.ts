export type FieldKind = 'string' | 'number' | 'boolean' | 'date' | 'enum';

export const ALL_FILTER_OPERATORS = [
  'eq',
  'contains',
  'in',
  'notIn',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
] as const;

export type FilterOperator = (typeof ALL_FILTER_OPERATORS)[number];

export type FieldDescriptor = {
  readonly kind: FieldKind;
  readonly optional?: boolean;
};

export type FieldDescriptorMap = Readonly<Record<string, FieldDescriptor>>;

export const OPERATORS_BY_KIND: Readonly<Record<FieldKind, readonly FilterOperator[]>> = {
  string: ['contains', 'in', 'notIn', 'isNull', 'isNotNull'],
  number: ['gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'isNull', 'isNotNull'],
  date: ['gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'isNull', 'isNotNull'],
  boolean: ['isNull', 'isNotNull'],
  enum: ['in', 'notIn', 'isNull', 'isNotNull'],
};

export const FILTER_DELIMITER = '__';
