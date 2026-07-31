CREATE TABLE IF NOT EXISTS manual_artists (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  artist_name TEXT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT,
  social_links TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_manual_artists_email ON manual_artists(email);
