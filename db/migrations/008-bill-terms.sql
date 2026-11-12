ALTER TABLE bills ADD COLUMN requires_acceptance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bills ADD COLUMN milestone_accepted_at TEXT;
ALTER TABLE bills ADD COLUMN milestone_accepted_by TEXT;
ALTER TABLE bills ADD COLUMN acceptance_evidence TEXT;
ALTER TABLE bills ADD COLUMN dispute_reason TEXT;

CREATE TABLE bill_installments (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  created_at TEXT NOT NULL
);
INSERT INTO bill_installments(id,bill_id,payment_id,created_at)
  SELECT 'initial:' || id,id,payment_id,created_at FROM bills WHERE payment_id IS NOT NULL;
CREATE TRIGGER initial_bill_installment AFTER UPDATE OF payment_id ON bills
  WHEN OLD.payment_id IS NULL AND NEW.payment_id IS NOT NULL
  BEGIN
    INSERT INTO bill_installments(id,bill_id,payment_id,created_at)
      VALUES ('initial:' || NEW.id,NEW.id,NEW.payment_id,NEW.updated_at);
  END;
