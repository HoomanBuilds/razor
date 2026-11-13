CREATE TABLE payment_funding_tasks (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  terms_hash TEXT NOT NULL,
  cash_committed TEXT NOT NULL DEFAULT '0',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE payment_funding_quotes (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  origin_token_json TEXT,
  state TEXT NOT NULL,
  funding_id TEXT REFERENCES funding_legs(id),
  lease_owner TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX payment_funding_active_quote ON payment_funding_quotes(payment_id) WHERE state IN ('quoting','active');
