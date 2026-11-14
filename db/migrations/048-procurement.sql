CREATE TABLE procurement_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  reference TEXT NOT NULL,
  specification_ciphertext TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL,
  budget TEXT NOT NULL,
  delivery_from TEXT NOT NULL,
  delivery_to TEXT NOT NULL,
  quote_deadline TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  approving_role_id TEXT NOT NULL REFERENCES organization_roles(id),
  inventory_item_id TEXT,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','open','awarded','cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,reference)
);
CREATE TABLE procurement_suppliers (
  request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  PRIMARY KEY(request_id,recipient_id)
);
CREATE TABLE procurement_quotes (
  request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  version INTEGER NOT NULL,
  supplier_version INTEGER NOT NULL,
  supplier_user_id TEXT NOT NULL,
  supplier_snapshot_ciphertext TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  total TEXT NOT NULL,
  delivery_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  terms_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(request_id,recipient_id,version)
);
CREATE TABLE procurement_awards (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES procurement_requests(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  quote_version INTEGER NOT NULL,
  commitment_id TEXT NOT NULL UNIQUE REFERENCES vendor_commitments(id),
  commitment_version INTEGER NOT NULL,
  terms_hash TEXT NOT NULL,
  awarded_by TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  FOREIGN KEY(request_id,recipient_id,quote_version) REFERENCES procurement_quotes(request_id,recipient_id,version)
);
CREATE TABLE procurement_receipts (
  id TEXT PRIMARY KEY,
  award_id TEXT NOT NULL REFERENCES procurement_awards(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('accepted','rejected','returned')),
  quantity TEXT NOT NULL,
  evidence_ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,request_key)
);
CREATE TABLE procurement_invoice_matches (
  bill_id TEXT PRIMARY KEY REFERENCES bills(id),
  award_id TEXT NOT NULL REFERENCES procurement_awards(id),
  quantity TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  matched_by TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at TEXT
);
CREATE TABLE procurement_inventory (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  sku TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  unit TEXT NOT NULL,
  on_hand TEXT NOT NULL DEFAULT '0',
  threshold TEXT NOT NULL,
  reorder_quantity TEXT NOT NULL,
  reorder_budget TEXT NOT NULL,
  supplier_ids TEXT NOT NULL,
  approving_role_id TEXT NOT NULL REFERENCES organization_roles(id),
  generation INTEGER NOT NULL DEFAULT 1,
  policy_version INTEGER NOT NULL DEFAULT 1,
  reorder_error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,sku)
);
CREATE TABLE procurement_stock_changes (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES procurement_inventory(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  request_key TEXT NOT NULL,
  delta TEXT NOT NULL,
  reason_ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,request_key)
);
CREATE TABLE procurement_reorders (
  item_id TEXT NOT NULL REFERENCES procurement_inventory(id),
  generation INTEGER NOT NULL,
  request_id TEXT NOT NULL REFERENCES procurement_requests(id),
  PRIMARY KEY(item_id,generation)
);
CREATE INDEX procurement_requests_company ON procurement_requests(organization_id,state,created_at);
CREATE INDEX procurement_receipts_award ON procurement_receipts(award_id,created_at);
CREATE INDEX procurement_invoice_award ON procurement_invoice_matches(award_id,accepted_at);
