CREATE TABLE retained_asset_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  amount TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  proof_ciphertext TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX retained_asset_events_company ON retained_asset_events(organization_id,created_at);
