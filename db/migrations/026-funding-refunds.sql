CREATE TABLE funding_refund_reviews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  funding_id TEXT NOT NULL REFERENCES funding_legs(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  terms_hash TEXT NOT NULL,
  terms_ciphertext TEXT NOT NULL,
  proof_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX funding_refund_reviews_leg ON funding_refund_reviews(funding_id,created_at);

CREATE TABLE funding_refund_closures (
  funding_id TEXT PRIMARY KEY REFERENCES funding_legs(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  review_id TEXT NOT NULL REFERENCES funding_refund_reviews(id),
  source_asset TEXT NOT NULL,
  source_network TEXT NOT NULL,
  refund_address TEXT NOT NULL,
  refunded_amount TEXT NOT NULL,
  reported_deposited_amount TEXT,
  transaction_hash TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('final_chain_receipt','funder_or_reporter_attestation')),
  evidence_ciphertext TEXT NOT NULL,
  confirmed_by TEXT NOT NULL REFERENCES users(id),
  confirmed_at TEXT NOT NULL
);

CREATE TABLE funding_refund_events (
  event_key TEXT PRIMARY KEY,
  funding_id TEXT NOT NULL REFERENCES funding_legs(id),
  created_at TEXT NOT NULL
);
