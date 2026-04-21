import { describe, expect, it } from 'vitest';
import { getPostgresSchema } from '../../src/postgres/get-postgres-schema.js';

describe('getPostgresSchema', () => {
  it('emits outbox_events and events tables by default', () => {
    const sql = getPostgresSchema();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS outbox_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS events');
  });

  it('does not emit consumer_offsets or dead_letter_events tables', () => {
    const sql = getPostgresSchema();
    expect(sql).not.toContain('consumer_offsets');
    expect(sql).not.toContain('dead_letter_events');
  });

  it('honors table name overrides', () => {
    const sql = getPostgresSchema({
      outboxTable: 'svc_outbox',
      eventsTable: 'svc_events',
    });
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS svc_outbox');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS svc_events');
    expect(sql).not.toContain('outbox_events');
  });

  it('includes claim tracking columns on both tables', () => {
    const sql = getPostgresSchema();
    expect(sql).toContain('claimed_by TEXT');
    expect(sql).toContain('claimed_at TIMESTAMPTZ');
    expect(sql).toContain('retry_count INTEGER NOT NULL');
    expect(sql).toContain('last_error TEXT');
  });

  it('declares no DEFAULT clauses (dumb-DB principle)', () => {
    const sql = getPostgresSchema();
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
  });

  it('uses plain UUID primary keys — no BIGSERIAL, no sequence_id', () => {
    const sql = getPostgresSchema();
    expect(sql).not.toContain('BIGSERIAL');
    expect(sql).not.toContain('sequence_id');
    expect(sql).toMatch(/id UUID PRIMARY KEY/);
  });

  it('creates partial indexes for the hot PENDING path on both tables', () => {
    const sql = getPostgresSchema();
    const pendingIndexMatches = sql.match(/WHERE status = 'PENDING'/g) ?? [];
    expect(pendingIndexMatches.length).toBeGreaterThanOrEqual(2);
  });

  it('creates a composite index supporting the aggregate-ordering guard', () => {
    const sql = getPostgresSchema();
    expect(sql).toContain('events_aggregate_id_status_idx');
    expect(sql).toContain("WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED'");
  });
});
