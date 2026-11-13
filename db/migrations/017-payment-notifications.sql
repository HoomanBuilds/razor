CREATE TABLE recipient_notices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  recipient_id TEXT NOT NULL REFERENCES recipients(id),
  entity_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX recipient_notices_user ON recipient_notices(user_id,created_at);

CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email_enabled INTEGER NOT NULL DEFAULT 0 CHECK(email_enabled IN (0,1)),
  enabled_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE notification_email_outbox (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('company','recipient')),
  source_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  email_ciphertext TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  next_attempt_at TEXT NOT NULL,
  provider_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_kind,source_id,user_id)
);

CREATE TRIGGER recipient_preference_notices AFTER UPDATE OF version ON recipients
WHEN NEW.version != OLD.version
BEGIN
  INSERT OR IGNORE INTO notices(id,organization_id,title,body,entity_id,required_permission,dedupe_key,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.organization_id,'Payee details changed','Review affected unexecuted obligations before authorizing a payment.',NEW.id,'payments:read','recipient:'||NEW.id||':version:'||NEW.version,NEW.updated_at);
  INSERT OR IGNORE INTO recipient_notices(id,organization_id,user_id,recipient_id,entity_id,event_key,title,body,created_at)
  SELECT lower(hex(randomblob(16))),NEW.organization_id,u.id,NEW.id,NEW.id,'recipient:'||NEW.id||':version:'||NEW.version||':user:'||u.id,
    CASE WHEN NEW.archived=1 THEN 'Payer profile archived' ELSE 'Your payout profile changed' END,
    'Review your payout preferences in your personal payment workspace. An existing approved payment keeps its recorded terms.',NEW.updated_at
  FROM users u WHERE u.id=OLD.user_id OR u.id=NEW.user_id;
END;

CREATE TRIGGER payment_status_notices AFTER UPDATE OF status ON payments
WHEN NEW.status != OLD.status AND NEW.status IN ('paid','held','unknown','recovery_pending','approved_unfunded','cancelled')
BEGIN
  INSERT OR IGNORE INTO notices(id,organization_id,title,body,entity_id,required_permission,dedupe_key,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.organization_id,
    CASE WHEN NEW.status='paid' THEN 'Payment delivery reconciled' WHEN NEW.status='cancelled' THEN 'Payment cancelled' ELSE 'Payment needs attention' END,
    'Open the payment record to review its current status, funding and settlement evidence.',NEW.id,'payments:read','payment:'||NEW.id||':status:'||NEW.status||':'||NEW.updated_at,NEW.updated_at);
  INSERT OR IGNORE INTO recipient_notices(id,organization_id,user_id,recipient_id,entity_id,event_key,title,body,created_at)
  SELECT lower(hex(randomblob(16))),NEW.organization_id,r.user_id,r.id,NEW.id,'payment:'||NEW.id||':status:'||NEW.status||':'||NEW.updated_at,
    CASE WHEN NEW.status='paid' AND EXISTS(SELECT 1 FROM payout_attempts a WHERE a.payment_id=NEW.id AND a.route='backup' AND a.state='delivered') THEN 'Payment delivered using your USDC backup'
      WHEN NEW.status='paid' THEN 'Payment delivery reconciled' WHEN NEW.status='cancelled' THEN 'Payment cancelled' ELSE 'Payment awaiting company action' END,
    'Open your personal payment history for the current status and any available receipt. A pending or held payment has not been reported as delivered.',NEW.updated_at
  FROM recipients r WHERE r.id=NEW.recipient_id AND r.organization_id=NEW.organization_id AND r.user_id IS NOT NULL;
END;

CREATE TRIGGER backup_delivery_notice AFTER UPDATE OF state ON payout_attempts
WHEN NEW.state='delivered' AND OLD.state!=NEW.state AND NEW.route='backup'
  AND EXISTS(SELECT 1 FROM payments p WHERE p.id=NEW.payment_id AND p.organization_id=NEW.organization_id AND p.status='paid')
BEGIN
  INSERT OR IGNORE INTO notices(id,organization_id,title,body,entity_id,required_permission,dedupe_key,created_at)
  VALUES(lower(hex(randomblob(16))),NEW.organization_id,'USDC backup delivery reconciled','Review the original obligation and recorded backup delivery receipt.',NEW.payment_id,'payments:read','backup-delivered:'||NEW.id,NEW.updated_at);
  INSERT OR IGNORE INTO recipient_notices(id,organization_id,user_id,recipient_id,entity_id,event_key,title,body,created_at)
  SELECT lower(hex(randomblob(16))),NEW.organization_id,r.user_id,r.id,p.id,'backup-delivered:'||NEW.id,
    'Payment delivered using your USDC backup','Your payer reconciled delivery using your consented USDC backup. Open your personal history for its receipt.',NEW.updated_at
  FROM payments p JOIN recipients r ON r.id=p.recipient_id AND r.organization_id=p.organization_id
  WHERE p.id=NEW.payment_id AND p.organization_id=NEW.organization_id AND r.user_id IS NOT NULL;
END;
