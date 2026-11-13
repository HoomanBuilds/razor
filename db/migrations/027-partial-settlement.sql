ALTER TABLE payout_attempts ADD COLUMN observed_output TEXT;
DROP INDEX one_active_payout;
CREATE UNIQUE INDEX one_active_payout ON payout_attempts(payment_id) WHERE state IN ('prepared','submitted','processing','unknown','recovery_pending','reported_delivered','reported_partial');

CREATE TABLE partial_settlement_reviews (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  payment_id TEXT NOT NULL REFERENCES payments(id),
  attempt_id TEXT NOT NULL REFERENCES payout_attempts(id),
  actual_output TEXT NOT NULL,
  credited_usdc TEXT NOT NULL,
  destination_tx_hash TEXT NOT NULL,
  receipt_commitment TEXT NOT NULL UNIQUE,
  evidence_ciphertext TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE partial_settlements (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES payout_attempts(id),
  review_id TEXT NOT NULL UNIQUE REFERENCES partial_settlement_reviews(id),
  actual_output TEXT NOT NULL,
  credited_usdc TEXT NOT NULL,
  source_spent_usdc TEXT NOT NULL,
  receipt_commitment TEXT NOT NULL UNIQUE,
  proof_ciphertext TEXT NOT NULL,
  confirmed_at TEXT NOT NULL
);
CREATE TABLE partial_remainders (
  original_payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  remainder_payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  remaining_usdc TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TRIGGER partial_retired_payment BEFORE UPDATE ON payments
WHEN EXISTS(SELECT 1 FROM partial_settlements s WHERE s.payment_id=OLD.id)
  AND (NEW.amount!=OLD.amount OR NEW.max_fee!=OLD.max_fee OR NEW.recipient_id!=OLD.recipient_id OR NEW.recipient_snapshot!=OLD.recipient_snapshot OR NEW.recipient_version!=OLD.recipient_version OR NEW.reference!=OLD.reference OR NEW.status!=OLD.status OR NEW.delivered_amount!=OLD.delivered_amount OR NEW.total_spent!=OLD.total_spent OR NEW.reserved_amount!=OLD.reserved_amount OR NEW.chain_reserved!=OLD.chain_reserved)
BEGIN SELECT RAISE(ABORT,'PARTIAL_LIABILITY: A terminal partial payment is immutable. Use its separately approved remainder.'); END;
CREATE TRIGGER partial_retired_attempt BEFORE INSERT ON payout_attempts
WHEN EXISTS(SELECT 1 FROM partial_settlements s WHERE s.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'PARTIAL_LIABILITY: A partially delivered payment cannot retry its full entitlement.'); END;
CREATE TRIGGER partial_remainder_amount BEFORE UPDATE OF amount ON payments
WHEN NEW.amount!=OLD.amount AND EXISTS(SELECT 1 FROM partial_remainders r WHERE r.remainder_payment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'PARTIAL_LIABILITY: The remainder keeps its exact unpaid entitlement. Review fees and recipient terms separately.'); END;
CREATE TRIGGER partial_retired_funding BEFORE INSERT ON funding_legs
WHEN EXISTS(SELECT 1 FROM partial_settlements s WHERE s.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'PARTIAL_LIABILITY: Fund the remainder instead of the terminal partial payment.'); END;
