PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS session_assignments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE,
  employee_slug TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested_owner', 'requested_employee', 'accepted', 'declined', 'cancelled')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('owner', 'employee')),
  request_note TEXT,
  response_note TEXT,
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_session_assignments_employee
  ON session_assignments(employee_slug, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_assignments_application
  ON session_assignments(application_id);
