ALTER TABLE applications ADD COLUMN payment_confirmation_email_status TEXT NOT NULL DEFAULT 'not_sent';
ALTER TABLE applications ADD COLUMN payment_confirmation_email_error TEXT;
ALTER TABLE applications ADD COLUMN payment_confirmation_email_message_id TEXT;
ALTER TABLE applications ADD COLUMN payment_confirmation_email_sent_at TEXT;
