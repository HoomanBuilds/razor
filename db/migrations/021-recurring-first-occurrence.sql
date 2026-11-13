ALTER TABLE recurring_rules ADD COLUMN initial_run_at TEXT;
UPDATE recurring_rules SET initial_run_at=COALESCE((SELECT MIN(due_at) FROM recurring_occurrences WHERE rule_id=recurring_rules.id),next_run_at);
