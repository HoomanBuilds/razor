ALTER TABLE clearing_rounds ADD COLUMN mode TEXT NOT NULL DEFAULT 'debt_discharge_v1' CHECK(mode IN ('debt_discharge_v1','cash_backed_native_v1'));
ALTER TABLE clearing_rounds ADD COLUMN cash_checked_at TEXT;
ALTER TABLE bills ADD COLUMN funded_clearing_amount TEXT NOT NULL DEFAULT '0';

CREATE TABLE clearing_funded_accounts (
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  destination TEXT NOT NULL,
  deposit_due TEXT NOT NULL,
  credit_due TEXT NOT NULL,
  deposited TEXT NOT NULL DEFAULT '0',
  credit_available TEXT NOT NULL DEFAULT '0',
  credit_paid TEXT NOT NULL DEFAULT '0',
  refund_available TEXT NOT NULL DEFAULT '0',
  refund_paid TEXT NOT NULL DEFAULT '0',
  nonce TEXT NOT NULL DEFAULT '0',
  pending_json TEXT,
  last_transfer_json TEXT,
  observed_height TEXT NOT NULL DEFAULT '0',
  observed_block_hash TEXT,
  stage TEXT NOT NULL DEFAULT 'funding',
  PRIMARY KEY(round_id,organization_id)
);
CREATE TABLE clearing_funded_deposits (
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  deposit_id TEXT NOT NULL,
  submitted TEXT NOT NULL,
  accepted TEXT NOT NULL,
  unused TEXT NOT NULL,
  source_transaction_hash TEXT NOT NULL,
  source_receipt_id TEXT NOT NULL,
  proof_ciphertext TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(round_id,organization_id,deposit_id),
  UNIQUE(source_transaction_hash,source_receipt_id)
);
CREATE TABLE clearing_funded_discharges (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  link_id TEXT NOT NULL UNIQUE REFERENCES clearing_links(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  bill_id TEXT NOT NULL REFERENCES bills(id),
  original_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  amount TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode='cash_backed_native_v1'),
  manifest_hash TEXT NOT NULL,
  proof_block_hash TEXT NOT NULL,
  proof_block_height TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE clearing_funded_wallet_requests (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL CHECK(operation IN ('register','consent','finalize','revoke','expire','fund','credit','refund','storage')),
  identity_key TEXT NOT NULL,
  amount TEXT,
  expected_nonce TEXT,
  actions_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','unknown','resolved')),
  review_generation TEXT NOT NULL,
  review_hash TEXT NOT NULL,
  review_expires_at TEXT NOT NULL,
  review_consumed INTEGER NOT NULL DEFAULT 0,
  wallet_lease_generation TEXT,
  wallet_lease_expires_at TEXT,
  source_transaction_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(round_id,organization_id,operation,identity_key)
);
CREATE UNIQUE INDEX clearing_funded_one_open_deposit ON clearing_funded_wallet_requests(round_id,organization_id)
WHERE operation='fund' AND state!='resolved';

CREATE TRIGGER funded_clearing_retired_payment BEFORE UPDATE ON payments
WHEN EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.original_payment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: This original liability became escrow-backed company rights and cannot be paid again.'); END;
CREATE TRIGGER funded_clearing_original_invoice_amount BEFORE UPDATE OF amount ON bills
WHEN NEW.amount!=OLD.amount AND EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.bill_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Preserve the original invoice amount and separate funded discharge.'); END;
CREATE TRIGGER funded_clearing_retired_funding BEFORE INSERT ON funding_legs
WHEN EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Escrow-backed company rights do not create another original payout.'); END;
CREATE TRIGGER funded_clearing_retired_attempt BEFORE INSERT ON payout_attempts
WHEN EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: The original invoice was retired into escrow-backed company rights.'); END;
CREATE TRIGGER funded_clearing_retired_client_reserve BEFORE INSERT ON client_reserves
WHEN EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not assign client cash to an escrow-discharged original invoice.'); END;
CREATE TRIGGER funded_clearing_retired_client_reserve_update BEFORE UPDATE OF payment_id ON client_reserves
WHEN EXISTS(SELECT 1 FROM clearing_funded_discharges s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not assign client cash to an escrow-discharged original invoice.'); END;
