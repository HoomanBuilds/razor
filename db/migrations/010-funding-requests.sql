CREATE TABLE funding_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  amount TEXT NOT NULL,
  purpose_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  capability_id TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  treasury_account_id TEXT NOT NULL,
  treasury_owner_id TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  network TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  revoked_at TEXT,
  fulfilled_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX funding_requests_company ON funding_requests(organization_id,created_at);
CREATE TABLE funding_request_quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES funding_requests(id),
  key_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  origin_token_json TEXT,
  refund_address TEXT NOT NULL,
  requested_output TEXT NOT NULL,
  funding_id TEXT UNIQUE REFERENCES funding_legs(id),
  state TEXT NOT NULL DEFAULT 'quoting',
  reservation_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(request_id,key_hash)
);
CREATE UNIQUE INDEX one_open_request_quote ON funding_request_quotes(request_id) WHERE state IN ('quoting','active');
