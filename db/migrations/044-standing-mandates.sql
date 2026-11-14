CREATE TABLE standing_mandates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  supplier_profile_hash TEXT NOT NULL,
  supplier_version INTEGER NOT NULL,
  terms_json TEXT NOT NULL,
  terms_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  invalidated_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX standing_vendor_enabled ON standing_mandates(organization_id,recipient_id) WHERE enabled=1;
CREATE TABLE standing_executions (
  payment_id TEXT PRIMARY KEY REFERENCES payments(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  mandate_id TEXT NOT NULL REFERENCES standing_mandates(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES payout_attempts(id),
  actor_account_id TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER standing_supplier_changed AFTER UPDATE OF version, archived ON recipients
WHEN NEW.version!=OLD.version OR NEW.archived!=OLD.archived
BEGIN
  UPDATE standing_mandates SET enabled=0,invalidated_at=NEW.updated_at,updated_at=NEW.updated_at WHERE recipient_id=NEW.id AND organization_id=NEW.organization_id;
  INSERT OR IGNORE INTO notices(id,organization_id,title,body,entity_id,required_permission,dedupe_key,created_at)
  SELECT lower(hex(randomblob(16))),NEW.organization_id,'Supplier automation invalidated','Supplier receiving details changed. Standing autopay is disabled. Review a new grant and its 24-hour onchain activation delay. Exact-route wallet review remains available.',NEW.id,'payments:read','standing-supplier:'||NEW.id||':'||NEW.version,NEW.updated_at
  WHERE EXISTS(SELECT 1 FROM standing_mandates WHERE recipient_id=NEW.id AND organization_id=NEW.organization_id);
END;
