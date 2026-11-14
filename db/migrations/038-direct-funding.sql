CREATE TABLE direct_funding_returns (
  funding_id TEXT PRIMARY KEY REFERENCES funding_legs(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  transaction_hash TEXT NOT NULL,
  amount TEXT NOT NULL,
  evidence TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
