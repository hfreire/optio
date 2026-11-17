-- A repo's default Claude Code sign-in can be an organization model provider.
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "claude_model_provider_id" uuid REFERENCES "model_providers"("id") ON DELETE SET NULL;
