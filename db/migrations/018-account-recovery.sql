ALTER TABLE linked_wallets ADD COLUMN last_verified_at TEXT;
ALTER TABLE sessions ADD COLUMN authentication_method TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE account_onboarding (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  wallet_provider TEXT,
  owner_wallet_id TEXT REFERENCES linked_wallets(id) ON DELETE SET NULL,
  backup_acknowledged_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE treasury_recovery_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  requested_by TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  terms_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  transaction_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT
);
CREATE INDEX treasury_recovery_company ON treasury_recovery_requests(organization_id,created_at);
