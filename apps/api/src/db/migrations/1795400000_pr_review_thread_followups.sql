-- Follow-ups on review threads: the last comment handled per thread, and threads left to a person.
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "thread_watermarks" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "pr_reviews" ADD COLUMN IF NOT EXISTS "held_threads" jsonb NOT NULL DEFAULT '[]'::jsonb;
