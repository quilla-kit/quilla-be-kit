export type PostgresSchemaOptions = {
  readonly outboxTable?: string;
  readonly eventsTable?: string;
  /** Emits the table `PgHandlerOutcomeStore` writes (default name `event_handler_outcomes`). */
  readonly handlerOutcomes?: boolean | { readonly table?: string };
};

// Every upgrade step checks the catalog first: ALTER TABLE and CREATE INDEX take table locks
// even when the column or index already exists.
function doIf(condition: string, statement: string): string {
  return `DO $$
BEGIN
  IF ${condition} THEN
    ${statement};
  END IF;
END $$;`;
}

function addColumn(table: string, column: string, type: string): string {
  return doIf(
    `NOT EXISTS (SELECT 1 FROM pg_attribute
      WHERE attrelid = '${table}'::regclass AND attname = '${column}' AND NOT attisdropped)`,
    `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`,
  );
}

function createIndex(name: string, on: string, unique = false): string {
  return doIf(
    `to_regclass('${name}') IS NULL`,
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON ${on}`,
  );
}

// Columns and indexes the claim, lease and retention SQL rely on, shared by both tables.
// seq and its default are separate steps: ADD COLUMN with a volatile default (nextval)
// rewrites the table. CACHE stays 1 so values follow nextval order across sessions.
function claimSupport(table: string): string[] {
  return [
    addColumn(table, 'lease_expires_at', 'TIMESTAMPTZ'),
    addColumn(table, 'failed_at', 'TIMESTAMPTZ'),
    addColumn(table, 'last_failed_by', 'TEXT'),
    addColumn(table, 'next_attempt_at', 'TIMESTAMPTZ'),
    addColumn(table, 'seq', 'BIGINT'),
    `CREATE SEQUENCE IF NOT EXISTS ${table}_seq OWNED BY ${table}.seq;`,
    doIf(
      `NOT EXISTS (SELECT 1 FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      WHERE d.adrelid = '${table}'::regclass AND a.attname = 'seq')`,
      `ALTER TABLE ${table} ALTER COLUMN seq SET DEFAULT nextval('${table}_seq')`,
    ),
    createIndex(
      `${table}_aggregate_id_seq_idx`,
      `${table} (aggregate_id, seq NULLS FIRST) WHERE aggregate_id IS NOT NULL AND status = 'PENDING'`,
    ),
    createIndex(
      `${table}_aggregate_id_status_idx`,
      `${table} (aggregate_id, status) WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED'`,
    ),
    createIndex(`${table}_claimed_at_idx`, `${table} (claimed_at) WHERE status = 'CLAIMED'`),
    createIndex(`${table}_failed_at_idx`, `${table} (failed_at) WHERE status = 'FAILED'`),
    // Only rows waiting for a retry: lets a claim skip the rest of their aggregate cheaply.
    createIndex(
      `${table}_retrying_idx`,
      `${table} (aggregate_id, seq) WHERE status = 'PENDING' AND next_attempt_at IS NOT NULL`,
    ),
  ];
}

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
  lease_expires_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  failed_at TIMESTAMPTZ,
  last_failed_by TEXT,
  next_attempt_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);`,
    ...claimSupport(outboxTable),
    createIndex(
      `${outboxTable}_seq_idx`,
      `${outboxTable} (seq NULLS FIRST, created_at) WHERE status = 'PENDING'`,
    ),
    `CREATE TABLE IF NOT EXISTS ${eventsTable} (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  source_service TEXT NOT NULL,
  aggregate_id TEXT,
  correlation_id TEXT,
  origin_event_id TEXT,
  status TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  lease_expires_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  failed_at TIMESTAMPTZ,
  last_failed_by TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);`,
    ...claimSupport(eventsTable),
    createIndex(
      `${eventsTable}_event_type_seq_idx`,
      `${eventsTable} (event_type, seq NULLS FIRST, created_at) WHERE status = 'PENDING'`,
    ),
    createIndex(
      `${eventsTable}_origin_event_id_uq`,
      `${eventsTable} (origin_event_id) WHERE origin_event_id IS NOT NULL`,
      true,
    ),
  ];

  const outcomes = options?.handlerOutcomes;
  if (outcomes) {
    const outcomesTable =
      (typeof outcomes === 'object' ? outcomes.table : undefined) ?? 'event_handler_outcomes';
    // Cascades with its bus row, so markDone and cleanupFailed clean it up.
    statements.push(`CREATE TABLE IF NOT EXISTS ${outcomesTable} (
  event_id UUID NOT NULL REFERENCES ${eventsTable}(id) ON DELETE CASCADE,
  handler_key TEXT NOT NULL,
  outcome TEXT NOT NULL,
  error TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, handler_key)
);`);
  }

  return `${statements.join('\n\n')}\n`;
}
