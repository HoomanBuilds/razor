CREATE TABLE IF NOT EXISTS treasury_config (
  organization_id TEXT PRIMARY KEY,
  near_account_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token_contract TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(network, near_account_id)
);
CREATE TABLE IF NOT EXISTS treasury_balances (
  organization_id TEXT PRIMARY KEY,
  balance TEXT NOT NULL DEFAULT '0',
  reserved TEXT NOT NULL DEFAULT '0',
  onchain_reserved TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reference TEXT NOT NULL,
  amount TEXT NOT NULL,
  max_fee TEXT NOT NULL,
  status TEXT NOT NULL,
  scheduled_for TEXT,
  recipient_version INTEGER NOT NULL,
  recipient_snapshot TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT,
  approved_at TEXT,
  reserved_amount TEXT NOT NULL DEFAULT '0',
  chain_reserved TEXT NOT NULL DEFAULT '0',
  total_spent TEXT NOT NULL DEFAULT '0',
  delivered_amount TEXT NOT NULL DEFAULT '0',
  hold_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, reference)
);
CREATE INDEX IF NOT EXISTS payments_org_status ON payments(organization_id, status, scheduled_for);
CREATE TABLE IF NOT EXISTS payout_attempts (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  organization_id TEXT NOT NULL,
  route TEXT NOT NULL,
  state TEXT NOT NULL,
  quote TEXT NOT NULL,
  destination_asset TEXT NOT NULL,
  destination_network TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deposit_memo TEXT,
  source_tx_hash TEXT,
  destination_tx_hash TEXT,
  refund_tx_hash TEXT,
  provider_status TEXT,
  reconciliation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_payout ON payout_attempts(payment_id) WHERE state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered');
CREATE TABLE IF NOT EXISTS funding_legs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  reference TEXT NOT NULL,
  origin_asset TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  quote TEXT NOT NULL,
  deposit_address TEXT NOT NULL,
  deposit_memo TEXT,
  recipient_address TEXT NOT NULL,
  status TEXT NOT NULL,
  source_tx_hash TEXT,
  destination_tx_hash TEXT,
  provider_status TEXT,
  credited_amount TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, reference)
);
CREATE TABLE IF NOT EXISTS treasury_ledger (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  entry_type TEXT NOT NULL,
  amount TEXT NOT NULL,
  balance_after TEXT NOT NULL,
  reserved_after TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(organization_id, reference)
);
CREATE TABLE IF NOT EXISTS payment_networks (
  organization_id TEXT NOT NULL,
  network TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(organization_id, network)
);
