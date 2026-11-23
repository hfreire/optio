-- Replies and resolves on existing review threads, drafted with the review and run on submit.
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "thread_actions" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "submit_claimed_at" timestamp with time zone;
