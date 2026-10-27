/**
 * Canonical names of the audit and timestamp columns under the default
 * `'kit'` audit policy. Tables that name them differently, or lack them,
 * declare an `AuditPolicy` on the DAO instead.
 */
export const AUDIT_COLUMNS = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  insertedBy: 'inserted_by',
  updatedBy: 'updated_by',
} as const;

export type AuditColumn = (typeof AUDIT_COLUMNS)[keyof typeof AUDIT_COLUMNS];
