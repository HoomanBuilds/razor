CREATE TABLE billing_legacy_capability_plans (
 plan_version_id TEXT PRIMARY KEY REFERENCES billing_plan_versions(id)
);
INSERT INTO billing_legacy_capability_plans SELECT id FROM billing_plan_versions;
CREATE TRIGGER billing_legacy_capability_insert_protected BEFORE INSERT ON billing_legacy_capability_plans BEGIN SELECT RAISE(ABORT,'BILLING_LEGACY_PLANS_FROZEN'); END;
CREATE TRIGGER billing_legacy_capability_update_protected BEFORE UPDATE ON billing_legacy_capability_plans BEGIN SELECT RAISE(ABORT,'BILLING_LEGACY_PLANS_FROZEN'); END;
CREATE TRIGGER billing_legacy_capability_delete_protected BEFORE DELETE ON billing_legacy_capability_plans BEGIN SELECT RAISE(ABORT,'BILLING_LEGACY_PLANS_FROZEN'); END;
CREATE TABLE billing_service_cost_observations (
 id TEXT PRIMARY KEY, capability TEXT NOT NULL, terms_json TEXT NOT NULL CHECK(json_valid(terms_json)),
 reviewed_by TEXT NOT NULL REFERENCES users(id), reviewed_at TEXT NOT NULL
);
CREATE TRIGGER billing_cost_update_protected BEFORE UPDATE ON billing_service_cost_observations BEGIN SELECT RAISE(ABORT,'BILLING_COST_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER billing_cost_delete_protected BEFORE DELETE ON billing_service_cost_observations BEGIN SELECT RAISE(ABORT,'BILLING_COST_OBSERVATION_IMMUTABLE'); END;
CREATE TABLE billing_capability_policies (
 plan_version_id TEXT PRIMARY KEY REFERENCES billing_plan_versions(id), mode TEXT NOT NULL CHECK(mode IN ('pilot','calibrated')),
 terms_json TEXT NOT NULL CHECK(json_valid(terms_json)), terms_hash TEXT NOT NULL,
 published_by TEXT NOT NULL REFERENCES users(id), published_at TEXT NOT NULL
);
CREATE TRIGGER billing_capability_policy_insert_guard BEFORE INSERT ON billing_capability_policies
WHEN EXISTS(SELECT 1 FROM billing_legacy_capability_plans WHERE plan_version_id=NEW.plan_version_id)
 OR NOT EXISTS(SELECT 1 FROM billing_plan_versions WHERE id=NEW.plan_version_id AND available=0)
 OR EXISTS(SELECT 1 FROM billing_invoices WHERE plan_version_id=NEW.plan_version_id)
BEGIN SELECT RAISE(ABORT,'BILLING_POLICY_REQUIRES_UNPUBLISHED_NEW_PLAN'); END;
CREATE TRIGGER billing_capability_policy_update_protected BEFORE UPDATE ON billing_capability_policies BEGIN SELECT RAISE(ABORT,'BILLING_CAPABILITY_POLICY_IMMUTABLE'); END;
CREATE TRIGGER billing_capability_policy_delete_protected BEFORE DELETE ON billing_capability_policies BEGIN SELECT RAISE(ABORT,'BILLING_CAPABILITY_POLICY_IMMUTABLE'); END;
CREATE TRIGGER billing_new_plan_publication_guard BEFORE INSERT ON billing_plan_versions WHEN NEW.available=1
BEGIN SELECT RAISE(ABORT,'BILLING_NEW_PLAN_POLICY_REQUIRED'); END;
CREATE TRIGGER billing_plan_publication_policy_guard BEFORE UPDATE OF available ON billing_plan_versions WHEN NEW.available=1 AND OLD.available=0
 AND NOT EXISTS(SELECT 1 FROM billing_capability_policies WHERE plan_version_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM billing_legacy_capability_plans WHERE plan_version_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'BILLING_NEW_PLAN_POLICY_REQUIRED'); END;
CREATE TABLE billing_optional_creation_usage (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL REFERENCES organizations(id),
 capability TEXT NOT NULL CHECK(capability IN ('private_tender','financing_request','claim_pool','procurement_rfq','accounting_plan','integration_credential')),
 resource_hash TEXT NOT NULL, usage_key TEXT NOT NULL, plan_version_id TEXT NOT NULL REFERENCES billing_plan_versions(id),
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
 UNIQUE(organization_id,capability,resource_hash)
);
CREATE INDEX billing_optional_usage_period ON billing_optional_creation_usage(organization_id,usage_key,capability);
CREATE TRIGGER billing_optional_usage_update_protected BEFORE UPDATE ON billing_optional_creation_usage BEGIN SELECT RAISE(ABORT,'BILLING_OPTIONAL_USAGE_IMMUTABLE'); END;
CREATE TRIGGER billing_optional_usage_delete_protected BEFORE DELETE ON billing_optional_creation_usage BEGIN SELECT RAISE(ABORT,'BILLING_OPTIONAL_USAGE_IMMUTABLE'); END;
