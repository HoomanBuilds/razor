CREATE TABLE billing_plan_versions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL CHECK(code IN ('free','pro','business')),
  version INTEGER NOT NULL CHECK(version > 0),
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USDC' CHECK(currency='USDC'),
  monthly_amount TEXT NOT NULL,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(code,version)
);

INSERT INTO billing_plan_versions(id,code,version,name,monthly_amount,features_json,limits_json,created_at) VALUES
('free-1','free',1,'Free','0','{"batch_payroll":false,"recurring":false,"private_ai":false,"clearing":false}','{"financeSeats":3,"aiAttempts":0}',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('pro-1','pro',1,'Pro','29000000','{"batch_payroll":true,"recurring":true,"private_ai":true,"clearing":true}','{"financeSeats":10,"aiAttempts":50}',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('business-1','business',1,'Business','99000000','{"batch_payroll":true,"recurring":true,"private_ai":true,"clearing":true}','{"financeSeats":50,"aiAttempts":500}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

CREATE TRIGGER billing_plan_terms_immutable BEFORE UPDATE ON billing_plan_versions
WHEN NEW.id!=OLD.id OR NEW.code!=OLD.code OR NEW.version!=OLD.version OR NEW.name!=OLD.name
  OR NEW.currency!=OLD.currency OR NEW.monthly_amount!=OLD.monthly_amount
  OR NEW.features_json!=OLD.features_json OR NEW.limits_json!=OLD.limits_json OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'BILLING_PLAN_IMMUTABLE'); END;

CREATE TABLE billing_subscription_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  revision INTEGER NOT NULL DEFAULT 0,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
  scheduled_plan_id TEXT REFERENCES billing_plan_versions(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_periods (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  plan_version_id TEXT NOT NULL REFERENCES billing_plan_versions(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  usage_key TEXT NOT NULL,
  anchor_day INTEGER NOT NULL CHECK(anchor_day BETWEEN 1 AND 31),
  source_invoice_id TEXT NOT NULL UNIQUE,
  replaces_period_id TEXT REFERENCES billing_periods(id),
  superseded_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(starts_at < ends_at)
);
CREATE INDEX billing_periods_company_time ON billing_periods(organization_id,starts_at,ends_at);

CREATE TABLE billing_usage (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  usage_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','completed','failed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(organization_id,request_key)
);
CREATE INDEX billing_usage_company_period ON billing_usage(organization_id,usage_key);

CREATE TABLE billing_core_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL
);
