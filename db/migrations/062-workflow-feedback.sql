CREATE TABLE workflow_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  workflow TEXT NOT NULL CHECK(workflow IN ('onboarding','funding','payroll','invoices','receiving','treasury','accounting','other')),
  category TEXT NOT NULL CHECK(category IN ('confusing','too_many_steps','cost_unclear','slow','unavailable','recovery')),
  severity TEXT NOT NULL CHECK(severity IN ('minor','difficult','blocked')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id,user_id,idempotency_key)
);
CREATE INDEX workflow_feedback_company_window ON workflow_feedback(organization_id,created_at);
CREATE INDEX workflow_feedback_author ON workflow_feedback(organization_id,user_id,created_at);
