-- A Claude config source URL that signs in (userinfo, a token parameter) is
-- sealed whole in these columns; "source_url" keeps the credential-free form.
-- Rows written before this are sealed the first time the worker syncs them.
ALTER TABLE "claude_config_sources" ADD COLUMN IF NOT EXISTS "encrypted_source_url" bytea;
ALTER TABLE "claude_config_sources" ADD COLUMN IF NOT EXISTS "source_url_iv" bytea;
ALTER TABLE "claude_config_sources" ADD COLUMN IF NOT EXISTS "source_url_auth_tag" bytea;
