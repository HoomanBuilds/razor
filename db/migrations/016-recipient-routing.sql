ALTER TABLE recipients ADD COLUMN primary_memo TEXT;
ALTER TABLE payout_attempts ADD COLUMN destination_memo TEXT;
