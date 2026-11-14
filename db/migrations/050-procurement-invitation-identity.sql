ALTER TABLE procurement_suppliers ADD COLUMN invited_user_id TEXT REFERENCES users(id);
CREATE INDEX procurement_invited_actor ON procurement_suppliers(invited_user_id,request_id);
