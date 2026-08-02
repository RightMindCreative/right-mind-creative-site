CREATE TABLE IF NOT EXISTS simon_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  application_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS simon_api_audit (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT,
  idempotency_key TEXT,
  application_id TEXT,
  outcome TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_simon_api_audit_created_at
  ON simon_api_audit(created_at DESC);
