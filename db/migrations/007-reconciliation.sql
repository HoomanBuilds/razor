CREATE TABLE funding_credit_receipts (
  id TEXT PRIMARY KEY,
  funding_id TEXT NOT NULL REFERENCES funding_legs(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  data_index INTEGER NOT NULL,
  amount TEXT NOT NULL,
  evidence TEXT NOT NULL,
  verified_by TEXT NOT NULL REFERENCES users(id),
  verified_at TEXT NOT NULL,
  UNIQUE(network, token_contract, receipt_id, log_index, data_index)
);
CREATE INDEX funding_receipts_leg ON funding_credit_receipts(funding_id);

ALTER TABLE funding_legs ADD COLUMN origin_network TEXT;
ALTER TABLE funding_legs ADD COLUMN origin_decimals INTEGER;
ALTER TABLE funding_legs ADD COLUMN origin_symbol TEXT;
ALTER TABLE payout_attempts ADD COLUMN destination_decimals INTEGER;
ALTER TABLE payout_attempts ADD COLUMN destination_symbol TEXT;

CREATE TABLE payment_source_receipts (
  attempt_id TEXT PRIMARY KEY REFERENCES payout_attempts(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  transaction_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  verified_by TEXT NOT NULL REFERENCES users(id),
  verified_at TEXT NOT NULL
);
