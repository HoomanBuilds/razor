CREATE TRIGGER financing_accepted_scope_immutable
BEFORE UPDATE OF scope_ciphertext,scope_id,scope_version,borrower_user_id,organization_id ON financing_requests
WHEN OLD.terms_hash IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'Preserve the exact accepted financing deployment, participants and operating scope.');
END;
