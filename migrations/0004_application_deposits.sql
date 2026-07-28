ALTER TABLE applications ADD COLUMN deposit_amount_cents INTEGER;
ALTER TABLE applications ADD COLUMN deposit_currency TEXT NOT NULL DEFAULT 'usd';
ALTER TABLE applications ADD COLUMN deposit_status TEXT NOT NULL DEFAULT 'not_required';
ALTER TABLE applications ADD COLUMN deposit_paid_at TEXT;
ALTER TABLE applications ADD COLUMN deposit_amount_paid_cents INTEGER;
ALTER TABLE applications ADD COLUMN stripe_payment_intent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_applications_deposit_status
  ON applications(deposit_status, updated_at DESC);
