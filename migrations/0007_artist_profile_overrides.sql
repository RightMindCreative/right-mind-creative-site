ALTER TABLE manual_artists ADD COLUMN linked_email TEXT;

CREATE INDEX IF NOT EXISTS idx_manual_artists_linked_email ON manual_artists(linked_email);
