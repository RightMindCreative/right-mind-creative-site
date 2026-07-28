ALTER TABLE applications ADD COLUMN calendar_sync_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE applications ADD COLUMN calendar_sync_error TEXT;
ALTER TABLE applications ADD COLUMN email_notification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE applications ADD COLUMN email_notification_error TEXT;
