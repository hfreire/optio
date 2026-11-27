-- A dotclaude-style git repo synced into the database and written to
-- /home/agent/.claude in Claude Code pods. One per scope: the workspace's
-- (repo_url NULL) and one per repo that replaces it for that repo.
CREATE TABLE IF NOT EXISTS "claude_config_sources" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"     uuid,
  "repo_url"         text,
  "source_url"       text NOT NULL,
  "ref"              text NOT NULL DEFAULT 'main',
  "subpath"          text NOT NULL DEFAULT '.',
  "resolved_sha"     text,
  "enabled"          boolean NOT NULL DEFAULT true,
  "last_synced_at"   timestamptz,
  "last_sync_error"  text,
  "file_count"       integer,
  "total_size_bytes" integer,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "claude_config_sources_scope_key"
  ON "claude_config_sources" ((coalesce("workspace_id"::text, '')), (coalesce("repo_url", '')));

CREATE TABLE IF NOT EXISTS "claude_config_files" (
  "source_id"    uuid NOT NULL REFERENCES "claude_config_sources" ("id") ON DELETE CASCADE,
  "path"         text NOT NULL,
  "content"      bytea NOT NULL,
  "executable"   boolean NOT NULL DEFAULT false,
  "resolved_sha" text,
  PRIMARY KEY ("source_id", "path")
);
