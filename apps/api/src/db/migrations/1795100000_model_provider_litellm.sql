-- LiteLLM model providers: a proxy URL instead of an AWS region, and the
-- machine env var that holds its key.
ALTER TABLE "model_providers" ALTER COLUMN "region" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "base_url" text;
--> statement-breakpoint
ALTER TABLE "model_providers" ADD COLUMN IF NOT EXISTS "local_api_key_env" text;
