/**
 * Sync worker for Claude config repos (`claude_config_sources`), the way
 * skill-sync-worker.ts syncs installed skills: resolve the ref with
 * `git ls-remote`, shallow-clone only when the commit moved, and write every
 * file and the sentinel to the database in one transaction so a run on any
 * instance reads a complete set.
 *
 *   - "sync-one" { id }  on demand (POST /api/claude-config/:id/sync)
 *   - "sync-due" {}      periodic; every enabled source (a no-op unless its ref
 *                        moved) plus any never synced or missing its files
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Queue, Worker } from "bullmq";
import { z } from "zod";
import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { parseIntEnv } from "@optio/shared";
import { logger } from "../logger.js";
import { formatSkillSyncError } from "../utils/skill-sync-error.js";
import { getBullMQOptions } from "../services/redis-config.js";
import { scheduleRepeat } from "../services/repeat-jobs.js";
import { underPollerLease } from "../services/poller-lease.js";
import { db } from "../db/client.js";
import { claudeConfigFiles, claudeConfigSources } from "../db/schema.js";
import {
  CLAUDE_CONFIG_SYNC_SENTINEL,
  claudeConfigFilesSynced,
  recordClaudeConfigSync,
  DEFAULT_CLAUDE_CONFIG_REF,
} from "../services/claude-config-service.js";
import {
  cloneIntoScratch,
  readSkillDir,
  resolveRefToSha,
  skillDirIn,
} from "./skill-sync-worker.js";

const bullmqOpts = getBullMQOptions();

const SYNC_INTERVAL_MS = parseIntEnv("OPTIO_CLAUDE_CONFIG_SYNC_INTERVAL", 300_000);
/** The same cap installed skills have; the files ride in OPTIO_SETUP_FILES. */
const MAX_CONFIG_BYTES = parseIntEnv("OPTIO_CLAUDE_CONFIG_MAX_BYTES", 1_048_576);

const CLAUDE_CONFIG_SYNC_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential", delay: 5_000 },
} as const;

const claudeConfigSyncQueue = new Queue("claude-config-sync", {
  ...bullmqOpts,
  defaultJobOptions: CLAUDE_CONFIG_SYNC_JOB_OPTIONS,
});

/** A sync-one found its source's lease held: retried by BullMQ with backoff. */
const syncOneDataSchema = z.object({ id: z.string().uuid() });

export class ClaudeConfigSyncBusyError extends Error {
  constructor(public readonly sourceId: string) {
    super(`Claude config source ${sourceId} is being synced by another instance; retrying`);
    this.name = "ClaudeConfigSyncBusyError";
  }
}

export async function processClaudeConfigSyncJob(job: {
  name: string;
  data: unknown;
}): Promise<void> {
  if (job.name === "sync-due") {
    await underPollerLease("claude-config-sync", async () => {
      const ids = new Set([...(await dueClaudeConfigIds()), ...(await enabledClaudeConfigIds())]);
      for (const id of ids) await enqueueClaudeConfigSync(id);
    });
  } else if (job.name === "sync-one") {
    const { id } = syncOneDataSchema.parse(job.data);
    const ran = await underPollerLease(`claude-config-sync:${id}`, async () => {
      await syncClaudeConfigOne(id);
      return true;
    });
    if (ran === null) throw new ClaudeConfigSyncBusyError(id);
  }
}

export function startClaudeConfigSyncWorker() {
  void scheduleRepeat(claudeConfigSyncQueue, "claude-config-sync.sync-due", SYNC_INTERVAL_MS, {
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  }).catch(() => {});

  claudeConfigSyncQueue
    .add("sync-due", {}, { removeOnComplete: true, removeOnFail: { count: 50 } })
    .catch((err) => logger.warn({ err }, "claude config sync: could not enqueue the boot pass"));

  const worker = new Worker("claude-config-sync", (job) => processClaudeConfigSyncJob(job), {
    ...bullmqOpts,
    concurrency: 4,
  });
  worker.on("failed", (job, err) => {
    if (err instanceof ClaudeConfigSyncBusyError) {
      logger.debug({ sourceId: err.sourceId, attempt: job?.attemptsMade }, err.message);
      return;
    }
    logger.error({ err, jobName: job?.name, jobId: job?.id }, "claude-config-sync job failed");
  });
  return worker;
}

/** Re-resolved each pass: a sync at an unmoved commit costs one `git ls-remote`. */
async function enabledClaudeConfigIds(): Promise<string[]> {
  const rows = await db
    .select({ id: claudeConfigSources.id })
    .from(claudeConfigSources)
    .where(eq(claudeConfigSources.enabled, true));
  return rows.map((r) => r.id);
}

export async function dueClaudeConfigIds(): Promise<string[]> {
  const rows = await db
    .select({ id: claudeConfigSources.id })
    .from(claudeConfigSources)
    .where(
      or(
        isNull(claudeConfigSources.resolvedSha),
        isNull(claudeConfigSources.lastSyncedAt),
        and(
          eq(claudeConfigSources.enabled, true),
          isNotNull(claudeConfigSources.resolvedSha),
          notExists(
            db
              .select({ one: sql`1` })
              .from(claudeConfigFiles)
              .where(
                and(
                  eq(claudeConfigFiles.sourceId, claudeConfigSources.id),
                  eq(claudeConfigFiles.path, CLAUDE_CONFIG_SYNC_SENTINEL),
                  eq(claudeConfigFiles.resolvedSha, claudeConfigSources.resolvedSha),
                ),
              ),
          ),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** The job id is the source's, so a sync already waiting absorbs a duplicate. */
export async function enqueueClaudeConfigSync(id: string): Promise<void> {
  await claudeConfigSyncQueue.add(
    "sync-one",
    { id },
    { jobId: `sync-one-${id}`, removeOnComplete: true, removeOnFail: true },
  );
}

export async function syncClaudeConfigOne(id: string): Promise<void> {
  const log = logger.child({ claudeConfigId: id });
  const [row] = await db.select().from(claudeConfigSources).where(eq(claudeConfigSources.id, id));
  if (!row) {
    log.warn("claude config source vanished before sync");
    return;
  }
  if (!row.enabled) {
    log.info("claude config source disabled; skipping sync");
    return;
  }

  const synced = { sourceUrl: row.sourceUrl, ref: row.ref, subpath: row.subpath };
  let clone: string | null = null;
  let stage = "resolve the source ref";
  try {
    const sha = await resolveRefToSha(row.sourceUrl, row.ref, {
      strict: { defaultRef: DEFAULT_CLAUDE_CONFIG_REF },
    });
    if (
      row.resolvedSha === sha &&
      row.lastSyncedAt &&
      !row.lastSyncError &&
      (await claudeConfigFilesSynced(id, sha))
    ) {
      log.info({ sha }, "already synced at this commit; nothing to do");
      return;
    }

    stage = "clone the source repository";
    clone = await cloneIntoScratch(row.sourceUrl, sha, log, { exact: true });
    stage = "read the config files";
    const dir = await skillDirIn(clone, row.subpath);
    if (!dir) throw new Error(`subpath '${row.subpath}' not found in source@${sha}`);

    const { files, totalSizeBytes } = await readSkillDir(dir, MAX_CONFIG_BYTES);
    const recorded = await recordClaudeConfigSync(
      id,
      { ok: true, resolvedSha: sha, totalSizeBytes, files },
      synced,
    );
    if (!recorded) {
      log.info({ sha }, "claude config source changed during the sync; result discarded");
      return;
    }
    log.info({ sha, fileCount: files.length, bytes: totalSizeBytes }, "claude config synced");
  } catch (err) {
    const msg = formatSkillSyncError(err, stage, row.sourceUrl);
    log.error({ error: msg }, "claude config sync failed");
    await recordClaudeConfigSync(id, { ok: false, error: msg }, synced);
  } finally {
    if (clone) await fs.rm(path.dirname(clone), { recursive: true, force: true }).catch(() => {});
  }
}
