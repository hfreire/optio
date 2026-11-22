import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { claudeConfigFiles, claudeConfigSources } from "../db/schema.js";
import { isUniqueViolation } from "../utils/db-errors.js";
import { normalizeSubpath } from "./installed-skill-service.js";
import { selectClaudeConfigSource, type ClaudeConfigFile } from "./claude-config.js";
import {
  normalizeRepoUrl,
  type ClaudeConfigSource,
  type CreateClaudeConfigSourceInput,
  type UpdateClaudeConfigSourceInput,
} from "@optio/shared";

const DEFAULT_REF = "main";

/** The scope (workspace, or workspace + repo) already has a Claude config source. */
export class ClaudeConfigScopeTakenError extends Error {
  constructor() {
    super("This scope already has a Claude config repo; update or delete it instead");
    this.name = "ClaudeConfigScopeTakenError";
  }
}

/** The input names something no source can have (a subpath that leaves the repo). */
export class ClaudeConfigInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeConfigInvalidInputError";
  }
}

function subpathOf(raw: string | undefined): string {
  try {
    return normalizeSubpath(raw);
  } catch (err) {
    throw new ClaudeConfigInvalidInputError(err instanceof Error ? err.message : "invalid subpath");
  }
}

/** The marker row every successful sync writes beside the files (content: the commit). */
export const CLAUDE_CONFIG_SYNC_SENTINEL = ".optio-synced";

export async function listClaudeConfigSources(
  workspaceId?: string | null,
): Promise<ClaudeConfigSource[]> {
  const rows = await db
    .select()
    .from(claudeConfigSources)
    .where(
      workspaceId
        ? or(
            eq(claudeConfigSources.workspaceId, workspaceId),
            isNull(claudeConfigSources.workspaceId),
          )
        : undefined,
    );
  return rows.map(mapRow);
}

export async function getClaudeConfigSource(id: string): Promise<ClaudeConfigSource | null> {
  const [row] = await db.select().from(claudeConfigSources).where(eq(claudeConfigSources.id, id));
  return row ? mapRow(row) : null;
}

export async function createClaudeConfigSource(
  input: CreateClaudeConfigSourceInput,
  workspaceId?: string | null,
): Promise<ClaudeConfigSource> {
  try {
    const [row] = await db
      .insert(claudeConfigSources)
      .values({
        workspaceId: workspaceId ?? null,
        repoUrl: input.repoUrl?.trim() ? normalizeRepoUrl(input.repoUrl.trim()) : null,
        sourceUrl: input.sourceUrl,
        ref: input.ref?.trim() || DEFAULT_REF,
        subpath: subpathOf(input.subpath),
        enabled: input.enabled ?? true,
      })
      .returning();
    return mapRow(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ClaudeConfigScopeTakenError();
    throw err;
  }
}

export async function updateClaudeConfigSource(
  id: string,
  input: UpdateClaudeConfigSourceInput,
): Promise<ClaudeConfigSource | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.sourceUrl !== undefined) updates.sourceUrl = input.sourceUrl;
  if (input.ref !== undefined) updates.ref = input.ref.trim() || DEFAULT_REF;
  if (input.subpath !== undefined) updates.subpath = subpathOf(input.subpath);
  // The change invalidates the resolved commit in the same statement, so the
  // source is due at once and a sync of the old one still in flight records nothing.
  if (input.sourceUrl !== undefined || input.ref !== undefined || input.subpath !== undefined) {
    updates.resolvedSha = null;
    updates.lastSyncError = null;
  }
  const [row] = await db
    .update(claudeConfigSources)
    .set(updates)
    .where(eq(claudeConfigSources.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

export async function deleteClaudeConfigSource(id: string): Promise<void> {
  await db.delete(claudeConfigSources).where(eq(claudeConfigSources.id, id));
}

export interface SyncedClaudeConfigFile {
  relativePath: string;
  content: Buffer;
  executable: boolean;
}

/**
 * Records a sync, only while the source still has the url, ref and subpath
 * the sync resolved (false, and nothing written, otherwise). On success the
 * files, replaced whole, the sentinel and the row's totals land in one
 * transaction.
 */
export async function recordClaudeConfigSync(
  id: string,
  result:
    | {
        ok: true;
        resolvedSha: string;
        totalSizeBytes: number;
        files: readonly SyncedClaudeConfigFile[];
      }
    | { ok: false; error: string },
  synced: { sourceUrl: string; ref: string; subpath: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: claudeConfigSources.id })
      .from(claudeConfigSources)
      .where(
        and(
          eq(claudeConfigSources.id, id),
          eq(claudeConfigSources.sourceUrl, synced.sourceUrl),
          eq(claudeConfigSources.ref, synced.ref),
          eq(claudeConfigSources.subpath, synced.subpath),
        ),
      )
      .for("update");
    if (!current) return false;

    if (!result.ok) {
      await tx
        .update(claudeConfigSources)
        .set({ lastSyncError: result.error, lastSyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(claudeConfigSources.id, id));
      return true;
    }

    const rows = [
      ...result.files
        .filter((f) => f.relativePath !== CLAUDE_CONFIG_SYNC_SENTINEL)
        .map((f) => ({
          sourceId: id,
          path: f.relativePath,
          content: f.content,
          executable: f.executable,
          resolvedSha: result.resolvedSha,
        })),
      {
        sourceId: id,
        path: CLAUDE_CONFIG_SYNC_SENTINEL,
        content: Buffer.from(result.resolvedSha),
        executable: false,
        resolvedSha: result.resolvedSha,
      },
    ];
    await tx.delete(claudeConfigFiles).where(eq(claudeConfigFiles.sourceId, id));
    await tx
      .insert(claudeConfigFiles)
      .values(rows)
      .onConflictDoUpdate({
        target: [claudeConfigFiles.sourceId, claudeConfigFiles.path],
        set: {
          content: sql`excluded.content`,
          executable: sql`excluded.executable`,
          resolvedSha: sql`excluded.resolved_sha`,
        },
      });
    await tx
      .update(claudeConfigSources)
      .set({
        resolvedSha: result.resolvedSha,
        fileCount: result.files.length,
        totalSizeBytes: result.totalSizeBytes,
        lastSyncedAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(claudeConfigSources.id, id));
    return true;
  });
}

/** Whether the source is synced at `sha` in the database (its sentinel row). */
export async function claudeConfigFilesSynced(sourceId: string, sha: string): Promise<boolean> {
  const [row] = await db
    .select({ path: claudeConfigFiles.path })
    .from(claudeConfigFiles)
    .where(
      and(
        eq(claudeConfigFiles.sourceId, sourceId),
        eq(claudeConfigFiles.path, CLAUDE_CONFIG_SYNC_SENTINEL),
        eq(claudeConfigFiles.resolvedSha, sha),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * The files of a source, from the database. With `expectedSha`, files from
 * another commit (a sync in flight) are refused rather than half-applied.
 */
export async function readClaudeConfigFiles(
  sourceId: string,
  expectedSha?: string | null,
): Promise<ClaudeConfigFile[]> {
  const rows = await db
    .select({
      path: claudeConfigFiles.path,
      content: claudeConfigFiles.content,
      executable: claudeConfigFiles.executable,
      resolvedSha: claudeConfigFiles.resolvedSha,
    })
    .from(claudeConfigFiles)
    .where(eq(claudeConfigFiles.sourceId, sourceId))
    .orderBy(claudeConfigFiles.path);
  if (!rows.some((r) => r.path === CLAUDE_CONFIG_SYNC_SENTINEL)) {
    throw new Error(`no synced files for Claude config source ${sourceId}`);
  }
  const other = expectedSha
    ? rows.find((r) => r.resolvedSha && r.resolvedSha !== expectedSha)
    : null;
  if (other) {
    throw new Error(
      `Claude config source ${sourceId} files are at ${other.resolvedSha}, expected ${expectedSha}`,
    );
  }
  return rows
    .filter((r) => r.path !== CLAUDE_CONFIG_SYNC_SENTINEL)
    .map((r) => ({
      relativePath: r.path,
      content: Buffer.from(r.content),
      executable: r.executable,
    }));
}

/**
 * The source a run uses: its repo's if it has a synced, enabled one, else the
 * workspace's. Null when none applies.
 */
export async function getClaudeConfigSourceForRun(
  repoUrl: string | null,
  workspaceId: string | null,
): Promise<ClaudeConfigSource | null> {
  const rows = (await listClaudeConfigSources(workspaceId)).filter(
    (s) => s.enabled && s.resolvedSha,
  );
  return selectClaudeConfigSource(rows, repoUrl, workspaceId);
}

function mapRow(row: typeof claudeConfigSources.$inferSelect): ClaudeConfigSource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    repoUrl: row.repoUrl,
    sourceUrl: row.sourceUrl,
    ref: row.ref,
    subpath: row.subpath,
    resolvedSha: row.resolvedSha,
    enabled: row.enabled,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
    fileCount: row.fileCount,
    totalSizeBytes: row.totalSizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
