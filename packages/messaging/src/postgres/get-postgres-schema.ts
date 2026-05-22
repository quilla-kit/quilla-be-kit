export type PostgresSchemaOptions = {
  readonly outboxTable?: string;
  readonly eventsTable?: string;
};

export function getPostgresSchema(options?: PostgresSchemaOptions): string {
  const outboxTable = options?.outboxTable ?? 'outbox_events';
  const eventsTable = options?.eventsTable ?? 'events';

  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${outboxTable} (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  aggregate_id TEXT,
  correlation_id TEXT,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);`,
    `CREATE INDEX IF NOT EXISTS ${outboxTable}_status_created_at_idx
  ON ${outboxTable} (status, created_at)
  WHERE status = 'PENDING';`,
    `CREATE INDEX IF NOT EXISTS ${outboxTable}_claimed_at_idx
  ON ${outboxTable} (claimed_at)
  WHERE status = 'CLAIMED';`,
    `CREATE TABLE IF NOT EXISTS ${eventsTable} (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  source_service TEXT NOT NULL,
  aggregate_id TEXT,
  correlation_id TEXT,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL
);`,
    `CREATE INDEX IF NOT EXISTS ${eventsTable}_event_type_created_at_idx
  ON ${eventsTable} (event_type, created_at)
  WHERE status = 'PENDING';`,
    `CREATE INDEX IF NOT EXISTS ${eventsTable}_aggregate_id_status_idx
  ON ${eventsTable} (aggregate_id, status)
  WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED';`,
    `CREATE INDEX IF NOT EXISTS ${eventsTable}_claimed_at_idx
  ON ${eventsTable} (claimed_at)
  WHERE status = 'CLAIMED';`,
  ];

  return `${statements.join('\n\n')}\n`;
}
