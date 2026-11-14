CREATE TABLE vendor_commitments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  reference TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','active','paused','cancelled')),
  current_version INTEGER,
  pending_version INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,reference)
);
CREATE INDEX vendor_commitments_company ON vendor_commitments(organization_id,state,reference);
CREATE TABLE vendor_commitment_versions (
  commitment_id TEXT NOT NULL REFERENCES vendor_commitments(id),
  version INTEGER NOT NULL,
  settlement_unit TEXT NOT NULL CHECK(settlement_unit='USDC'),
  supplier_version INTEGER NOT NULL,
  supplier_user_id TEXT,
  supplier_name_ciphertext TEXT NOT NULL,
  scope_ciphertext TEXT NOT NULL,
  allowance TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK(cadence IN ('total','monthly')),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  target_state TEXT NOT NULL CHECK(target_state IN ('active','paused','cancelled')),
  reason_ciphertext TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  withdrawn_by TEXT,
  withdrawn_at TEXT,
  PRIMARY KEY(commitment_id,version)
);
ALTER TABLE bills ADD COLUMN vendor_commitment_id TEXT REFERENCES vendor_commitments(id);
ALTER TABLE bills ADD COLUMN commitment_date TEXT;
ALTER TABLE bills ADD COLUMN commitment_scope_confirmed INTEGER NOT NULL DEFAULT 0;
CREATE TABLE vendor_commitment_uses (
  bill_id TEXT PRIMARY KEY REFERENCES bills(id),
  commitment_id TEXT NOT NULL REFERENCES vendor_commitments(id),
  version INTEGER NOT NULL,
  period_key TEXT NOT NULL,
  amount TEXT NOT NULL,
  accepted_by TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  FOREIGN KEY(commitment_id,version) REFERENCES vendor_commitment_versions(commitment_id,version)
);
CREATE INDEX vendor_commitment_period_use ON vendor_commitment_uses(commitment_id,period_key);
