CREATE TABLE support_cases (
 id TEXT PRIMARY KEY, sender_user_id TEXT NOT NULL REFERENCES users(id), organization_id TEXT REFERENCES organizations(id),
 category TEXT NOT NULL, subject_ciphertext TEXT, context_ciphertext TEXT, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 1,
 idempotency_hash TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(sender_user_id,idempotency_hash)
);
CREATE INDEX support_sender_history ON support_cases(sender_user_id,created_at,id);
CREATE INDEX support_retention ON support_cases(expires_at,status);
CREATE TABLE support_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, case_id TEXT NOT NULL REFERENCES support_cases(id), actor_user_id TEXT REFERENCES users(id), actor_role TEXT NOT NULL,
 kind TEXT NOT NULL, previous_status TEXT, next_status TEXT, idempotency_hash TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(case_id,actor_user_id,idempotency_hash)
);
CREATE INDEX support_case_history ON support_events(case_id,sequence);
CREATE INDEX support_actor_capacity ON support_events(actor_user_id,created_at);
CREATE TABLE support_messages (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE REFERENCES support_events(id), case_id TEXT NOT NULL REFERENCES support_cases(id),
 body_ciphertext TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX support_thread ON support_messages(case_id,sequence);
CREATE TABLE support_rate_limits (
 user_id TEXT NOT NULL REFERENCES users(id), hour_bucket TEXT NOT NULL, actions INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(user_id,hour_bucket)
);
