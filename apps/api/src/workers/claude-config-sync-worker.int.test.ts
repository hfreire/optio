/**
 * Claude config repos synced into the database: the worker clones a source
 * (a local git repository here), writes every file and the sentinel, and the
 * spawn-time reader finds them with no filesystem in common.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { claudeConfigFiles, claudeConfigSources } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  ClaudeConfigScopeTakenError,
  createClaudeConfigSource,
  deleteClaudeConfigSource,
  getClaudeConfigSourceForRun,
  readClaudeConfigFiles,
} from "../services/claude-config-service.js";

const queued = vi.hoisted(() => [] as { name: string; id?: string }[]);

vi.mock("bullmq", () => ({
  Queue: class {
    add(name: string, data: { id?: string }) {
      queued.push({ name, id: data?.id });
      return Promise.resolve();
    }
  },
  Worker: class {
    on() {}
    close() {
      return Promise.resolve();
    }
  },
}));

const run = promisify(execFile);
let root: string;
let source: string;

async function git(args: string[]) {
  await run("git", args, {
    cwd: source,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    },
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "optio-claude-config-int-"));
  process.env.OPTIO_SKILLS_SCRATCH_DIR = path.join(root, "scratch");
  source = path.join(root, "source");
  await fs.mkdir(path.join(source, "hooks"), { recursive: true });
  await fs.mkdir(path.join(source, "home", "skills", "tdd"), { recursive: true });
  await fs.writeFile(path.join(source, "CLAUDE.md"), "# rules\n");
  await fs.writeFile(path.join(source, "settings.json"), '{"attribution":{"commit":""}}');
  await fs.writeFile(path.join(source, "hooks", "guard.sh"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(source, "hooks", "guard.sh"), 0o755);
  await fs.writeFile(path.join(source, "home", "skills", "tdd", "SKILL.md"), "tdd\n");
  await git(["init", "-q", "-b", "main"]);
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "init"]);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function newSource(subpath = ".", repoUrl?: string) {
  const ws = await insertWorkspace();
  const row = await createClaudeConfigSource(
    { sourceUrl: `file://${source}`, subpath, repoUrl },
    ws.id,
  );
  return { ws, row };
}

describe("claude config sync", () => {
  it("writes the files with their exec bits and reads them back by commit", async () => {
    const { syncClaudeConfigOne, dueClaudeConfigIds } =
      await import("./claude-config-sync-worker.js");
    const { row } = await newSource();
    expect(await dueClaudeConfigIds()).toContain(row.id);
    await syncClaudeConfigOne(row.id);

    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(after.lastSyncError).toBeNull();
    expect(after.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    expect(after.fileCount).toBe(4);

    const files = await readClaudeConfigFiles(row.id, after.resolvedSha);
    expect(files.map((f) => f.relativePath)).toEqual([
      "CLAUDE.md",
      "home/skills/tdd/SKILL.md",
      "hooks/guard.sh",
      "settings.json",
    ]);
    expect(files.find((f) => f.relativePath === "hooks/guard.sh")?.executable).toBe(true);
    expect(await dueClaudeConfigIds()).not.toContain(row.id);
    await expect(readClaudeConfigFiles(row.id, "0".repeat(40))).rejects.toThrow(/expected/);
  });

  it("syncs a subpath, is a no-op at the same commit and replaces the set at a new one", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { row } = await newSource("home");
    await syncClaudeConfigOne(row.id);
    const [first] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect((await readClaudeConfigFiles(row.id)).map((f) => f.relativePath)).toEqual([
      "skills/tdd/SKILL.md",
    ]);

    await syncClaudeConfigOne(row.id);
    const [second] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(second.lastSyncedAt?.getTime()).toBe(first.lastSyncedAt?.getTime());

    await fs.writeFile(path.join(source, "home", "extra.md"), "more\n");
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "more"]);
    await syncClaudeConfigOne(row.id);
    const [third] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(third.resolvedSha).not.toBe(first.resolvedSha);
    expect(
      (await readClaudeConfigFiles(row.id, third.resolvedSha)).map((f) => f.relativePath),
    ).toEqual(["extra.md", "skills/tdd/SKILL.md"]);
  });

  it("records a missing subpath as the sync error", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { row } = await newSource("nope");
    await syncClaudeConfigOne(row.id);
    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(after.resolvedSha).toBeNull();
    expect(after.lastSyncError).toContain("nope");
  });

  it("discards a sync whose ref moved while it ran", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { recordClaudeConfigSync } = await import("../services/claude-config-service.js");
    const { row } = await newSource();
    const recorded = await recordClaudeConfigSync(
      row.id,
      { ok: true, resolvedSha: "a".repeat(40), totalSizeBytes: 0, files: [] },
      { sourceUrl: row.sourceUrl, ref: "other", subpath: row.subpath },
    );
    expect(recorded).toBe(false);
    await syncClaudeConfigOne(row.id);
    expect((await readClaudeConfigFiles(row.id)).length).toBeGreaterThan(0);
  });

  it("allows one source per scope, and cascades the files on delete", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { ws, row } = await newSource();
    await expect(
      createClaudeConfigSource({ sourceUrl: `file://${source}` }, ws.id),
    ).rejects.toBeInstanceOf(ClaudeConfigScopeTakenError);
    const repoLevel = await createClaudeConfigSource(
      { sourceUrl: `file://${source}`, repoUrl: "https://github.com/acme/a" },
      ws.id,
    );
    await expect(
      createClaudeConfigSource(
        { sourceUrl: `file://${source}`, repoUrl: "https://github.com/acme/a" },
        ws.id,
      ),
    ).rejects.toBeInstanceOf(ClaudeConfigScopeTakenError);

    await syncClaudeConfigOne(row.id);
    await deleteClaudeConfigSource(row.id);
    expect(
      await db.select().from(claudeConfigFiles).where(eq(claudeConfigFiles.sourceId, row.id)),
    ).toEqual([]);
    expect(repoLevel.workspaceId).toBe(ws.id);
  });

  it("picks the repo's source over the workspace's, and only synced, enabled ones", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const ws = await insertWorkspace();
    const repoUrl = "https://github.com/acme/picked";
    const wsLevel = await createClaudeConfigSource({ sourceUrl: `file://${source}` }, ws.id);
    const repoLevel = await createClaudeConfigSource(
      { sourceUrl: `file://${source}`, repoUrl },
      ws.id,
    );
    expect(await getClaudeConfigSourceForRun(repoUrl, ws.id)).toBeNull();

    await syncClaudeConfigOne(wsLevel.id);
    expect((await getClaudeConfigSourceForRun(repoUrl, ws.id))?.id).toBe(wsLevel.id);
    expect((await getClaudeConfigSourceForRun(null, ws.id))?.id).toBe(wsLevel.id);

    await syncClaudeConfigOne(repoLevel.id);
    expect((await getClaudeConfigSourceForRun(repoUrl, ws.id))?.id).toBe(repoLevel.id);
    expect((await getClaudeConfigSourceForRun("https://github.com/acme/else", ws.id))?.id).toBe(
      wsLevel.id,
    );
    expect(await getClaudeConfigSourceForRun(repoUrl, (await insertWorkspace()).id)).toBeNull();
  });
});

describe("claude config sync worker", () => {
  it("re-syncs every enabled source each pass, not only the due ones", async () => {
    const { processClaudeConfigSyncJob, syncClaudeConfigOne } =
      await import("./claude-config-sync-worker.js");
    const synced = (await newSource()).row;
    await syncClaudeConfigOne(synced.id);
    const off = (await newSource()).row;
    await syncClaudeConfigOne(off.id);
    await db
      .update(claudeConfigSources)
      .set({ enabled: false })
      .where(eq(claudeConfigSources.id, off.id));
    queued.length = 0;
    await processClaudeConfigSyncJob({ name: "sync-due", data: {} });
    const ids = queued.filter((q) => q.name === "sync-one").map((q) => q.id);
    expect(ids).toContain(synced.id);
    expect(ids).not.toContain(off.id);
  });

  it("picks up a commit pushed to the tracked ref", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const upstream = path.join(root, "moving");
    await fs.mkdir(upstream);
    const gitIn = (args: string[]) =>
      run("git", args, {
        cwd: upstream,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "commit.gpgsign",
          GIT_CONFIG_VALUE_0: "false",
        },
      });
    await fs.writeFile(path.join(upstream, "CLAUDE.md"), "v1\n");
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["add", "."]);
    await gitIn(["commit", "-q", "-m", "one"]);
    const ws = await insertWorkspace();
    const row = await createClaudeConfigSource({ sourceUrl: `file://${upstream}` }, ws.id);
    await syncClaudeConfigOne(row.id);
    const [first] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));

    await fs.writeFile(path.join(upstream, "CLAUDE.md"), "v2\n");
    await gitIn(["commit", "-qam", "two"]);
    await syncClaudeConfigOne(row.id);
    const [second] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(second.resolvedSha).not.toBe(first.resolvedSha);
    const files = await readClaudeConfigFiles(row.id, second.resolvedSha);
    expect(files[0].content.toString()).toBe("v2\n");
  });

  it("skips a disabled source", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { row } = await newSource();
    await db
      .update(claudeConfigSources)
      .set({ enabled: false })
      .where(eq(claudeConfigSources.id, row.id));
    await syncClaudeConfigOne(row.id);
    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(after.resolvedSha).toBeNull();
  });

  it("runs a sync-one job, and asks to be retried while another instance holds the source", async () => {
    const { processClaudeConfigSyncJob, ClaudeConfigSyncBusyError } =
      await import("./claude-config-sync-worker.js");
    const { underPollerLease } = await import("../services/poller-lease.js");
    const { row } = await newSource();
    await underPollerLease(
      `claude-config-sync:${row.id}`,
      async () => {
        await expect(
          processClaudeConfigSyncJob({ name: "sync-one", data: { id: row.id } }),
        ).rejects.toBeInstanceOf(ClaudeConfigSyncBusyError);
      },
      "other-instance",
    );
    await processClaudeConfigSyncJob({ name: "sync-one", data: { id: row.id } });
    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(after.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps serving the last snapshot after an edit until the new location syncs", async () => {
    const { syncClaudeConfigOne, dueClaudeConfigIds } =
      await import("./claude-config-sync-worker.js");
    const { updateClaudeConfigSource } = await import("../services/claude-config-service.js");
    const { ws, row } = await newSource();
    await syncClaudeConfigOne(row.id);
    expect(await dueClaudeConfigIds()).not.toContain(row.id);

    await updateClaudeConfigSource(row.id, { subpath: "home" });
    expect(await dueClaudeConfigIds()).toContain(row.id);
    expect((await getClaudeConfigSourceForRun(null, ws.id))?.id).toBe(row.id);

    await syncClaudeConfigOne(row.id);
    expect(await dueClaudeConfigIds()).not.toContain(row.id);
    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    const files = await readClaudeConfigFiles(row.id, after.resolvedSha);
    expect(files.map((f) => f.relativePath)).toContain("skills/tdd/SKILL.md");
    expect(files.map((f) => f.relativePath)).not.toContain("hooks/guard.sh");
  });

  it("keeps the old snapshot and records the error when the new location fails", async () => {
    const { syncClaudeConfigOne } = await import("./claude-config-sync-worker.js");
    const { updateClaudeConfigSource } = await import("../services/claude-config-service.js");
    const { ws, row } = await newSource();
    await syncClaudeConfigOne(row.id);
    await updateClaudeConfigSource(row.id, { subpath: "nope" });
    await syncClaudeConfigOne(row.id);
    const [after] = await db
      .select()
      .from(claudeConfigSources)
      .where(eq(claudeConfigSources.id, row.id));
    expect(after.lastSyncError).toContain("nope");
    expect(after.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
    expect((await getClaudeConfigSourceForRun(null, ws.id))?.id).toBe(row.id);
    expect(
      (await readClaudeConfigFiles(row.id, after.resolvedSha)).map((f) => f.relativePath),
    ).toContain("hooks/guard.sh");
  });

  it("rejects a sync-one job with no source id", async () => {
    const { processClaudeConfigSyncJob } = await import("./claude-config-sync-worker.js");
    await expect(processClaudeConfigSyncJob({ name: "sync-one", data: {} })).rejects.toThrow();
  });
});
