-- Replies and resolves on existing review threads, drafted with the review and run on submit.
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "thread_actions" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "thread_action_progress" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "submit_claimed_at" timestamp with time zone;
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "posted_review_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
