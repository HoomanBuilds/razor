CREATE TABLE project_funding_classifications (
  funding_id TEXT PRIMARY KEY REFERENCES funding_legs(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_reference_ciphertext TEXT NOT NULL,
  cost_center_reference_ciphertext TEXT,
  classification TEXT NOT NULL CHECK(classification IN ('earned_revenue','client_deposit','internal_transfer')),
  evidence_ciphertext TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL
);
CREATE TABLE project_funding_events (
  id TEXT PRIMARY KEY,
  funding_id TEXT NOT NULL REFERENCES funding_legs(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  details_ciphertext TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(funding_id,version)
);
