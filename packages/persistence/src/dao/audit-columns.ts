/**
 * Canonical names for the audit and timestamp columns the toolkit manages.
 * Referenced by `BaseWriteDao` (excluded-keys filtering, audit injection)
 * and by `PgWriteDbAdapter` (timestamp SQL literals). Change these here
 * if your schema uses different column names — callers derive their
 * strings from this constant rather than hard-coding them.
 */
export const AUDIT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  insertedBy: 'inserted_by',
  updatedBy: 'updated_by',
} as const;

export type AuditColumn = (typeof AUDIT_COLUMNS)[keyof typeof AUDIT_COLUMNS];

/** Keys stripped from `insert` inputs — the DB generates these. */
export const INSERT_EXCLUDED_KEYS: ReadonlySet<string> = new Set([
  AUDIT_COLUMNS.createdAt,
  AUDIT_COLUMNS.updatedAt,
]);

/** Keys stripped from `update` SET clauses — immutable post-insert or DB-generated. */
export const UPDATE_EXCLUDED_KEYS: ReadonlySet<string> = new Set<string>([
  'id',
  AUDIT_COLUMNS.createdAt,
  AUDIT_COLUMNS.updatedAt,
  AUDIT_COLUMNS.insertedBy,
]);
