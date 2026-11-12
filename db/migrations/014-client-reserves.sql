CREATE TABLE client_reserves (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL,
  creation_fingerprint TEXT NOT NULL,
  amount TEXT NOT NULL,
  purpose_ciphertext TEXT NOT NULL,
  client_reference_ciphertext TEXT,
  funding_id TEXT REFERENCES funding_legs(id),
  payment_id TEXT REFERENCES payments(id),
  payment_terms_hash TEXT,
  state TEXT NOT NULL DEFAULT 'held',
  release_reason_ciphertext TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  allocated_at TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,request_key)
);
CREATE UNIQUE INDEX client_reserve_principal ON client_reserves(payment_id) WHERE payment_id IS NOT NULL AND state!='released';
CREATE INDEX client_reserves_company ON client_reserves(organization_id,state,created_at);
CREATE TABLE client_reserve_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  reserve_id TEXT NOT NULL REFERENCES client_reserves(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,
  details_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,request_key)
);
