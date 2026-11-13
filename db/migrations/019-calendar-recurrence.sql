ALTER TABLE recurring_rules ADD COLUMN cadence TEXT NOT NULL DEFAULT 'days' CHECK(cadence IN ('days','months'));
ALTER TABLE recurring_rules ADD COLUMN interval_months INTEGER NOT NULL DEFAULT 1 CHECK(interval_months BETWEEN 1 AND 12);
ALTER TABLE recurring_rules ADD COLUMN anchor_day INTEGER CHECK(anchor_day BETWEEN 1 AND 31);
ALTER TABLE recurring_rules ADD COLUMN month_end INTEGER NOT NULL DEFAULT 0 CHECK(month_end IN (0,1));
