ALTER TABLE bills ADD COLUMN setoff_amount TEXT NOT NULL DEFAULT '0';

CREATE TABLE clearing_companies (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  treasury_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet')),
  token_contract TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(network,treasury_id)
);
CREATE TABLE clearing_links (
  id TEXT PRIMARY KEY,
  debtor_id TEXT NOT NULL REFERENCES organizations(id),
  creditor_id TEXT NOT NULL REFERENCES organizations(id),
  bill_id TEXT NOT NULL REFERENCES bills(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  terms_hash TEXT NOT NULL,
  terms_ciphertext TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offered' CHECK(status IN ('offered','accepted','revoked','cleared')),
  offered_by TEXT NOT NULL REFERENCES users(id),
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(debtor_id!=creditor_id)
);
CREATE UNIQUE INDEX clearing_one_live_offer ON clearing_links(bill_id,payment_id) WHERE status IN ('offered','accepted');
CREATE TABLE clearing_link_shares (
  link_id TEXT NOT NULL REFERENCES clearing_links(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  debtor_consent INTEGER NOT NULL DEFAULT 0,
  creditor_consent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(link_id,organization_id)
);
CREATE TABLE clearing_rounds (
  id TEXT PRIMARY KEY,
  manifest_hash TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','registered','applying','cleared','revoked','expired','rejected')),
  network TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  proof_ciphertext TEXT,
  applied_at TEXT
);
CREATE TABLE clearing_round_participants (
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  PRIMARY KEY(round_id,organization_id)
);
CREATE TABLE clearing_round_links (
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  link_id TEXT NOT NULL REFERENCES clearing_links(id),
  bill_id TEXT NOT NULL REFERENCES bills(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  PRIMARY KEY(round_id,link_id)
);
CREATE INDEX clearing_active_payment ON clearing_round_links(payment_id,round_id);
CREATE TABLE clearing_setoffs (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES clearing_rounds(id),
  link_id TEXT NOT NULL UNIQUE REFERENCES clearing_links(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  bill_id TEXT NOT NULL REFERENCES bills(id),
  original_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  residual_payment_id TEXT REFERENCES payments(id),
  amount TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  proof_block_hash TEXT NOT NULL,
  proof_block_height TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER clearing_payment_locked BEFORE UPDATE ON payments
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=OLD.id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: This draft belongs to a pending clearing round. Revoke or expire its NEAR commitment before changing it.'); END;
CREATE TRIGGER clearing_bill_locked BEFORE UPDATE ON bills
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.bill_id=OLD.id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: This invoice belongs to a pending clearing round. Revoke or expire its NEAR commitment before changing it.'); END;
CREATE TRIGGER clearing_funding_locked BEFORE INSERT ON funding_legs
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=NEW.payment_id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: This obligation is held for consented clearing and cannot receive payment funding.'); END;
CREATE TRIGGER clearing_attempt_locked BEFORE INSERT ON payout_attempts
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=NEW.payment_id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: This obligation is held for consented clearing and cannot prepare a payout.'); END;
CREATE TRIGGER clearing_recipient_locked BEFORE UPDATE ON recipients
WHEN NEW.version!=OLD.version AND EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id JOIN payments p ON p.id=l.payment_id WHERE p.recipient_id=OLD.id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: Revoke or expire the pending clearing round before changing this business recipient.'); END;
CREATE TRIGGER clearing_registration_locked BEFORE UPDATE ON clearing_companies
WHEN EXISTS(SELECT 1 FROM clearing_round_participants p JOIN clearing_rounds r ON r.id=p.round_id WHERE p.organization_id=OLD.organization_id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: Revoke or expire active clearing rounds before changing participation.'); END;
CREATE TRIGGER clearing_retired_payment BEFORE UPDATE ON payments
WHEN EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.original_payment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: This payment was retired by consented clearing. Use its residual invoice draft.'); END;
CREATE TRIGGER clearing_original_invoice_amount BEFORE UPDATE OF amount ON bills
WHEN NEW.amount!=OLD.amount AND EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.bill_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: The original invoice amount remains immutable after clearing.'); END;
CREATE TRIGGER clearing_retired_funding BEFORE INSERT ON funding_legs
WHEN EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Fund the residual invoice draft instead of the retired payment.'); END;
CREATE TRIGGER clearing_retired_attempt BEFORE INSERT ON payout_attempts
WHEN EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Pay the residual invoice draft instead of the retired payment.'); END;
CREATE TRIGGER clearing_client_reserve_locked BEFORE UPDATE OF payment_id ON client_reserves
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=NEW.payment_id AND r.status IN ('prepared','registered'))
  OR EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: Client cash cannot be committed to a pending clearing obligation.'); END;
CREATE TRIGGER clearing_client_reserve_insert_locked BEFORE INSERT ON client_reserves
WHEN EXISTS(SELECT 1 FROM clearing_round_links l JOIN clearing_rounds r ON r.id=l.round_id WHERE l.payment_id=NEW.payment_id AND r.status IN ('prepared','registered'))
  OR EXISTS(SELECT 1 FROM clearing_setoffs s WHERE s.original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: Client cash cannot be assigned to an active or retired clearing obligation.'); END;
CREATE TRIGGER clearing_owner_locked BEFORE UPDATE OF owner_id ON organizations
WHEN NEW.owner_id!=OLD.owner_id AND EXISTS(SELECT 1 FROM clearing_round_participants p JOIN clearing_rounds r ON r.id=p.round_id WHERE p.organization_id=OLD.id AND r.status IN ('prepared','registered'))
BEGIN SELECT RAISE(ABORT,'CLEARING_LOCKED: Revoke or expire active rounds before changing company ownership.'); END;
