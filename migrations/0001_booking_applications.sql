PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'reviewing', 'approved', 'declined', 'payment_pending', 'confirmed', 'cancelled')),
  category TEXT NOT NULL,
  service TEXT NOT NULL,
  service_option TEXT,
  preferred_date TEXT,
  preferred_time TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  artist_name TEXT,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  stem_count INTEGER,
  social_links TEXT,
  notes TEXT,
  google_event_id TEXT,
  stripe_checkout_session_id TEXT,
  stripe_payment_status TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);

CREATE TABLE IF NOT EXISTS application_files (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_application_files_application
  ON application_files(application_id);
