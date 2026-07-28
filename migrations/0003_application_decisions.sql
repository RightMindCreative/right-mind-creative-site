ALTER TABLE applications ADD COLUMN decided_at TEXT;
ALTER TABLE applications ADD COLUMN public_status_token TEXT;
ALTER TABLE applications ADD COLUMN decision_email_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE applications ADD COLUMN decision_email_error TEXT;
ALTER TABLE applications ADD COLUMN decision_email_message_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_public_status_token
  ON applications(public_status_token);
