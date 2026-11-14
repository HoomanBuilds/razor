CREATE INDEX insights_payment_cohort ON payments(organization_id,created_at,id);
CREATE INDEX insights_attempt_payment ON payout_attempts(organization_id,payment_id,created_at,id);
CREATE INDEX insights_subscription_confirmed ON billing_invoices(organization_id,confirmed_at,id);
CREATE INDEX insights_noncash_recorded ON clearing_setoffs(organization_id,created_at,id);
CREATE INDEX insights_funded_recorded ON clearing_funded_discharges(organization_id,created_at,id);
