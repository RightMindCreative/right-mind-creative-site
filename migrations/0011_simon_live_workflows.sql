ALTER TABLE applications ADD COLUMN simon_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE applications ADD COLUMN archived_at TEXT;
ALTER TABLE applications ADD COLUMN archive_reason TEXT;
ALTER TABLE applications ADD COLUMN agreed_total_minor INTEGER;
ALTER TABLE applications ADD COLUMN booking_starts_at TEXT;
ALTER TABLE applications ADD COLUMN booking_ends_at TEXT;
