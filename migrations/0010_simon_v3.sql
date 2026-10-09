CREATE TABLE IF NOT EXISTS simon_v3_resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  state TEXT,
  owner_person_id TEXT,
  data_json TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_simon_v3_resources_kind_updated
  ON simon_v3_resources(kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_simon_v3_resources_owner
  ON simon_v3_resources(owner_person_id, kind);

CREATE TABLE IF NOT EXISTS simon_v3_operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  requester_person_id TEXT NOT NULL,
  requester_role TEXT NOT NULL,
  status TEXT NOT NULL,
  resource_refs_json TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_simon_v3_operations_created
  ON simon_v3_operations(created_at DESC);

CREATE TABLE IF NOT EXISTS simon_v3_events (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  action TEXT NOT NULL,
  requester_person_id TEXT NOT NULL,
  requester_role TEXT NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  operation_id TEXT,
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_simon_v3_events_created
  ON simon_v3_events(created_at DESC);
