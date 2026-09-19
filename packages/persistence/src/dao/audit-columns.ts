import type { AuditPolicy, ResolvedAudit } from './audit-policy.type.js';

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

const FIELDS = Object.keys(AUDIT_COLUMNS) as (keyof typeof AUDIT_COLUMNS)[];

/** Reduces an `AuditPolicy` to the columns it actually declares. */
export function resolveAuditPolicy(policy: AuditPolicy): ResolvedAudit {
  if (policy === 'none') return {};
  const columns: Record<string, string> = {};
  for (const field of FIELDS) {
    const declared = policy === 'kit' ? AUDIT_COLUMNS[field] : policy[field];
    if (typeof declared === 'string') columns[field] = declared;
  }
  return columns;
}
