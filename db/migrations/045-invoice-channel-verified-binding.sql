ALTER TABLE invoice_channels ADD COLUMN binding_verified_at TEXT;
DROP INDEX invoice_channels_active_binding;
UPDATE invoice_channels SET verified_at=NULL WHERE provider IN ('telegram','whatsapp');
CREATE UNIQUE INDEX invoice_channels_active_binding ON invoice_channels(provider,binding_hash)
  WHERE revoked_at IS NULL AND binding_verified_at IS NOT NULL;
