ALTER TABLE bills ADD COLUMN accepted_credit_amount TEXT NOT NULL DEFAULT '0';
CREATE TABLE invoice_credit_notes (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organizations(id), bill_id TEXT NOT NULL REFERENCES bills(id), recipient_id TEXT NOT NULL REFERENCES recipients(id),
 supplier_user_id TEXT NOT NULL REFERENCES users(id), supplier_version INTEGER NOT NULL, reference_ciphertext TEXT NOT NULL, reference_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected','withdrawn')), current_version INTEGER NOT NULL DEFAULT 1,
 accepted_version INTEGER, accepted_by TEXT REFERENCES users(id), accepted_at TEXT, accepted_review_hash TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(organization_id,supplier_user_id,reference_hash)
);
CREATE INDEX invoice_credit_bill ON invoice_credit_notes(organization_id,bill_id,created_at,id);
CREATE INDEX invoice_credit_supplier ON invoice_credit_notes(supplier_user_id,created_at,id);
CREATE TABLE invoice_credit_versions (
 note_id TEXT NOT NULL REFERENCES invoice_credit_notes(id), version INTEGER NOT NULL, amount TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit='USDC'),
 reason_ciphertext TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, PRIMARY KEY(note_id,version)
);
CREATE TABLE invoice_credit_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, note_id TEXT NOT NULL REFERENCES invoice_credit_notes(id), version INTEGER NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id), actor_role TEXT NOT NULL CHECK(actor_role IN ('supplier','company')), kind TEXT NOT NULL,
 reason_ciphertext TEXT NOT NULL, idempotency_hash TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(actor_user_id,idempotency_hash)
);
CREATE TABLE invoice_credit_retirements (
 payment_id TEXT PRIMARY KEY REFERENCES payments(id), note_id TEXT NOT NULL REFERENCES invoice_credit_notes(id), organization_id TEXT NOT NULL REFERENCES organizations(id),
 bill_id TEXT NOT NULL REFERENCES bills(id), original_amount TEXT NOT NULL, retired_at TEXT NOT NULL
);
CREATE TRIGGER invoice_credit_version_immutable BEFORE UPDATE ON invoice_credit_versions BEGIN SELECT RAISE(ABORT,'Accepted and proposed credit versions are immutable; append a revision.'); END;
CREATE TRIGGER invoice_credit_version_not_deleted BEFORE DELETE ON invoice_credit_versions BEGIN SELECT RAISE(ABORT,'Preserve invoice credit history.'); END;
CREATE TRIGGER invoice_credit_accepted_immutable BEFORE UPDATE ON invoice_credit_notes WHEN OLD.status='accepted' BEGIN SELECT RAISE(ABORT,'Accepted credit notes are immutable.'); END;
CREATE TRIGGER invoice_credit_face_immutable BEFORE UPDATE OF amount ON bills WHEN NEW.amount!=OLD.amount AND EXISTS(SELECT 1 FROM invoice_credit_notes n WHERE n.bill_id=OLD.id AND n.status='accepted')
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Preserve original invoice face value after an accepted credit.'); END;
CREATE TRIGGER invoice_credit_retired_payment BEFORE UPDATE ON payments WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: This unsigned draft was retired by an accepted credit and cannot be paid again.'); END;
CREATE TRIGGER invoice_credit_retired_bill_pointer BEFORE UPDATE OF payment_id ON bills WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Prepare a new bounded installment instead of reopening a credited draft.'); END;
CREATE TRIGGER invoice_credit_retired_replacement BEFORE INSERT ON payment_replacements WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.old_payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Review the remaining invoice after credit; never replace the retired full draft.'); END;
CREATE TRIGGER invoice_credit_retired_funding BEFORE INSERT ON funding_legs WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not fund a draft retired by an accepted credit.'); END;
CREATE TRIGGER invoice_credit_retired_attempt BEFORE INSERT ON payout_attempts WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not pay a draft retired by an accepted credit.'); END;
CREATE TRIGGER invoice_credit_retired_reserve BEFORE INSERT ON client_reserves WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not reserve client cash for a credited retired draft.'); END;
CREATE TRIGGER invoice_credit_retired_reserve_update BEFORE UPDATE OF payment_id ON client_reserves WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not reserve client cash for a credited retired draft.'); END;

CREATE TRIGGER invoice_credit_event_immutable BEFORE UPDATE ON invoice_credit_events BEGIN SELECT RAISE(ABORT,'Preserve immutable invoice credit decisions.'); END;
CREATE TRIGGER invoice_credit_event_not_deleted BEFORE DELETE ON invoice_credit_events BEGIN SELECT RAISE(ABORT,'Preserve invoice credit history.'); END;
CREATE TRIGGER invoice_credit_retirement_immutable BEFORE UPDATE ON invoice_credit_retirements BEGIN SELECT RAISE(ABORT,'Preserve immutable credited draft retirement.'); END;
CREATE TRIGGER invoice_credit_retirement_not_deleted BEFORE DELETE ON invoice_credit_retirements BEGIN SELECT RAISE(ABORT,'Preserve credited draft retirement.'); END;
CREATE TRIGGER invoice_credit_retired_installment BEFORE INSERT ON bill_installments WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Do not relink a retired credited draft as a fresh installment.'); END;
CREATE TRIGGER invoice_credit_retired_installment_update BEFORE UPDATE OF payment_id,bill_id ON bill_installments WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=NEW.payment_id OR r.payment_id=OLD.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Preserve retired invoice installment lineage.'); END;

DROP TRIGGER initial_bill_installment;
CREATE TRIGGER initial_bill_installment AFTER UPDATE OF payment_id ON bills
WHEN OLD.payment_id IS NULL AND NEW.payment_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM bill_installments i WHERE i.bill_id=NEW.id AND i.payment_id=NEW.payment_id)
BEGIN
 INSERT INTO bill_installments(id,bill_id,payment_id,created_at) VALUES('initial:' || NEW.id,NEW.id,NEW.payment_id,NEW.updated_at);
END;
CREATE TRIGGER invoice_credit_retired_installment_delete BEFORE DELETE ON bill_installments WHEN EXISTS(SELECT 1 FROM invoice_credit_retirements r WHERE r.payment_id=OLD.payment_id)
BEGIN SELECT RAISE(ABORT,'CLEARED_LIABILITY: Preserve retired invoice installment lineage.'); END;
