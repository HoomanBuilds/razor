CREATE TABLE expense_paid_corrections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  expense_id TEXT NOT NULL REFERENCES expense_requests(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  staff_user_id TEXT NOT NULL REFERENCES users(id),
  expense_version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  proposed_by TEXT NOT NULL REFERENCES users(id),
  proposer_role TEXT NOT NULL CHECK (proposer_role IN ('staff','company')),
  corrected_amount TEXT NOT NULL,
  return_amount TEXT NOT NULL,
  source_ciphertext TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  terms_hash TEXT NOT NULL UNIQUE,
  reason_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','cancelled','returned')),
  version INTEGER NOT NULL DEFAULT 1,
  company_consent_by TEXT REFERENCES users(id),
  staff_consent_by TEXT REFERENCES users(id),
  replaces_id TEXT UNIQUE REFERENCES expense_paid_corrections(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(proposed_by,request_key)
);
CREATE UNIQUE INDEX expense_correction_open ON expense_paid_corrections(expense_id) WHERE status IN ('proposed','accepted','returned');
CREATE INDEX expense_correction_company ON expense_paid_corrections(organization_id,expense_id,created_at);

CREATE TABLE expense_return_legs (
  id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES expense_paid_corrections(id),
  amount TEXT NOT NULL,
  source_account TEXT NOT NULL,
  source_public_key TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  target_ciphertext TEXT NOT NULL,
  instructions_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','signing','source_unknown','confirmed')),
  review_token TEXT NOT NULL UNIQUE,
  review_expires_at TEXT NOT NULL,
  begun_at TEXT,
  transaction_hash TEXT,
  reported_transaction_hash TEXT,
  credit_id TEXT,
  proof_ciphertext TEXT,
  confirmed_at TEXT,
  balance_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX expense_return_pending ON expense_return_legs(correction_id) WHERE state!='confirmed';
CREATE TABLE expense_return_receipts (
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  data_index INTEGER NOT NULL,
  leg_id TEXT NOT NULL REFERENCES expense_return_legs(id),
  credit_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  amount TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(network,token_contract,receipt_id,log_index,data_index),
  UNIQUE(network,token_contract,company_id,credit_id)
);
CREATE TABLE expense_correction_events (
  id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES expense_paid_corrections(id),
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL,
  version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  note_ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);
