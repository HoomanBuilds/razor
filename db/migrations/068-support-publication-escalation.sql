CREATE TABLE support_staffing_publications (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL UNIQUE, terms_json TEXT NOT NULL CHECK(json_valid(terms_json)), terms_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','withdrawn')),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, published_at TEXT, withdrawn_at TEXT
);
CREATE UNIQUE INDEX support_one_published_staffing ON support_staffing_publications(status) WHERE status='published';
CREATE TRIGGER support_staffing_terms_immutable BEFORE UPDATE ON support_staffing_publications
WHEN NEW.id!=OLD.id OR NEW.version!=OLD.version OR NEW.terms_json!=OLD.terms_json OR NEW.terms_hash!=OLD.terms_hash OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'SUPPORT_STAFFING_TERMS_IMMUTABLE'); END;
CREATE TRIGGER support_staffing_delete_protected BEFORE DELETE ON support_staffing_publications BEGIN SELECT RAISE(ABORT,'SUPPORT_STAFFING_TERMS_IMMUTABLE'); END;
CREATE TABLE support_staff_acknowledgments (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, publication_id TEXT NOT NULL REFERENCES support_staffing_publications(id),
 user_id TEXT NOT NULL REFERENCES users(id), terms_hash TEXT NOT NULL, accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
 request_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE TRIGGER support_staff_ack_update_protected BEFORE UPDATE ON support_staff_acknowledgments BEGIN SELECT RAISE(ABORT,'SUPPORT_STAFF_ACK_IMMUTABLE'); END;
CREATE TRIGGER support_staff_ack_delete_protected BEFORE DELETE ON support_staff_acknowledgments BEGIN SELECT RAISE(ABORT,'SUPPORT_STAFF_ACK_IMMUTABLE'); END;
CREATE TABLE support_publication_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, publication_id TEXT NOT NULL REFERENCES support_staffing_publications(id),
 user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TRIGGER support_publication_event_update_protected BEFORE UPDATE ON support_publication_events BEGIN SELECT RAISE(ABORT,'SUPPORT_PUBLICATION_EVENT_IMMUTABLE'); END;
CREATE TRIGGER support_publication_event_delete_protected BEFORE DELETE ON support_publication_events BEGIN SELECT RAISE(ABORT,'SUPPORT_PUBLICATION_EVENT_IMMUTABLE'); END;
CREATE TABLE support_escalations (
 id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE REFERENCES support_cases(id), reason TEXT NOT NULL CHECK(reason IN ('transfer_outcome_unknown','delivery_missing','funding_credit_missing','refund_recovery_held')),
 status TEXT NOT NULL CHECK(status IN ('queued','acknowledged','resolved')), publication_id TEXT REFERENCES support_staffing_publications(id),
 requested_at TEXT NOT NULL, acknowledged_at TEXT, resolved_at TEXT, assigned_operator_id TEXT REFERENCES users(id)
);
CREATE INDEX support_escalation_queue ON support_escalations(status,requested_at);
CREATE TRIGGER support_escalation_case_fixed BEFORE UPDATE ON support_escalations
WHEN NEW.id!=OLD.id OR NEW.case_id!=OLD.case_id
BEGIN SELECT RAISE(ABORT,'SUPPORT_ESCALATION_CASE_FIXED'); END;
