CREATE TABLE recovery_operations (
  id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  operator_user_id TEXT NOT NULL REFERENCES users(id),
  operator_account_id TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  treasury_account_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('refund','source','retained')),
  entity_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  wallet_call_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','signed','uncertain','confirmed','failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX recovery_one_unresolved ON recovery_operations(organization_id,kind,entity_id)
WHERE status IN ('prepared','signed','uncertain');
CREATE TABLE recovery_submissions (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES recovery_operations(id),
  public_key TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  signed_transaction_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('signed','uncertain','confirmed','failed','refused')),
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE recovery_signer_locks (
  network TEXT NOT NULL,
  account_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(network,account_id)
);
