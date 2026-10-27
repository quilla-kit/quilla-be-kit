import { AUDIT_COLUMNS } from '../db-adapter/audit-columns.js';
import type { AuditPolicy, ResolvedAudit } from './audit-policy.type.js';

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
