export type AuditColumnMap = {
  readonly createdAt?: string | false;
  readonly updatedAt?: string | false;
  readonly insertedBy?: string | false;
  readonly updatedBy?: string | false;
};

/**
 * Which audit/timestamp columns a table carries. `'kit'` is the four
 * conventional columns (`created_at`, `updated_at`, `inserted_by`,
 * `updated_by`), `'none'` is a table with none of them, and a map declares
 * each column by name (omit an entry or pass `false` when the table lacks it).
 */
export type AuditPolicy = 'kit' | 'none' | AuditColumnMap;

export type ResolvedAudit = { readonly [K in keyof AuditColumnMap]?: string };
