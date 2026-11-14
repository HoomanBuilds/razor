CREATE TABLE integration_credentials (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  principal_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  last_used_at TEXT,
  rate_window INTEGER NOT NULL DEFAULT 0,
  rate_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX integration_credentials_company ON integration_credentials(organization_id,created_at);
CREATE TABLE integration_request_leases (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES integration_credentials(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE integration_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  credential_id TEXT NOT NULL REFERENCES integration_credentials(id),
  idempotency_key TEXT NOT NULL,
  terms_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('payment','invoice','recipient')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,credential_id,idempotency_key)
);
CREATE TABLE integration_webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE integration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  event_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(organization_id,source_key)
);
CREATE TABLE integration_webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES integration_webhook_endpoints(id),
  event_id TEXT NOT NULL REFERENCES integration_events(id),
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  cycle_attempts INTEGER NOT NULL DEFAULT 0,
  replay_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(endpoint_id,event_id)
);
CREATE INDEX integration_webhook_ready ON integration_webhook_deliveries(state,next_attempt_at);
CREATE TABLE integration_webhook_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES integration_webhook_deliveries(id),
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status INTEGER,
  error TEXT
);
CREATE TABLE integration_payment_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_amount TEXT NOT NULL,
  published_at TEXT
);
CREATE TRIGGER integration_payment_created AFTER INSERT ON payments BEGIN
  INSERT INTO integration_payment_changes(payment_id,organization_id,status,updated_at,delivered_amount)
    VALUES(NEW.id,NEW.organization_id,NEW.status,NEW.updated_at,NEW.delivered_amount);
END;
CREATE TRIGGER integration_payment_changed AFTER UPDATE OF status,delivered_amount ON payments
WHEN NEW.status!=OLD.status OR NEW.delivered_amount!=OLD.delivered_amount BEGIN
  INSERT INTO integration_payment_changes(payment_id,organization_id,status,updated_at,delivered_amount)
    VALUES(NEW.id,NEW.organization_id,NEW.status,NEW.updated_at,NEW.delivered_amount);
END;
CREATE TABLE integration_state_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  kind TEXT NOT NULL CHECK(kind IN ('funding','invoice','payroll')),
  status TEXT NOT NULL,
  credited_amount TEXT,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE TRIGGER integration_funding_created AFTER INSERT ON funding_legs BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,credited_amount,updated_at)
    VALUES(NEW.id,NEW.organization_id,'funding',NEW.status,NEW.credited_amount,NEW.updated_at);
END;
CREATE TRIGGER integration_funding_changed AFTER UPDATE OF status,credited_amount ON funding_legs
WHEN NEW.status!=OLD.status OR NEW.credited_amount!=OLD.credited_amount BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,credited_amount,updated_at)
    VALUES(NEW.id,NEW.organization_id,'funding',NEW.status,NEW.credited_amount,NEW.updated_at);
END;
CREATE TRIGGER integration_invoice_created AFTER INSERT ON bills BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,updated_at)
    VALUES(NEW.id,NEW.organization_id,'invoice',NEW.status,NEW.updated_at);
END;
CREATE TRIGGER integration_invoice_changed AFTER UPDATE OF status ON bills WHEN NEW.status!=OLD.status BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,updated_at)
    VALUES(NEW.id,NEW.organization_id,'invoice',NEW.status,NEW.updated_at);
END;
CREATE TRIGGER integration_payroll_created AFTER INSERT ON payroll_runs BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,updated_at)
    VALUES(NEW.id,NEW.organization_id,'payroll',NEW.status,NEW.updated_at);
END;
CREATE TRIGGER integration_payroll_changed AFTER UPDATE OF status ON payroll_runs WHEN NEW.status!=OLD.status BEGIN
  INSERT INTO integration_state_changes(resource_id,organization_id,kind,status,updated_at)
    VALUES(NEW.id,NEW.organization_id,'payroll',NEW.status,NEW.updated_at);
END;
