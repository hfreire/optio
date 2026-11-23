import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { claudeConfigSources } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  ClaudeConfigInvalidInputError,
  createClaudeConfigSource,
  recordClaudeConfigSync,
  updateClaudeConfigSource,
} from "./claude-config-service.js";

async function syncedSource() {
  const ws = await insertWorkspace();
  const row = await createClaudeConfigSource({ sourceUrl: "https://github.com/acme/dot" }, ws.id);
  await recordClaudeConfigSync(
    row.id,
    { ok: true, resolvedSha: "a".repeat(40), totalSizeBytes: 1, files: [] },
    { sourceUrl: row.sourceUrl, ref: row.ref, subpath: row.subpath },
  );
  await db
    .update(claudeConfigSources)
    .set({ lastSyncError: "old failure" })
    .where(eq(claudeConfigSources.id, row.id));
  return row;
}

const reload = async (id: string) =>
  (await db.select().from(claudeConfigSources).where(eq(claudeConfigSources.id, id)))[0];

describe("updateClaudeConfigSource", () => {
  it.each([{ sourceUrl: "https://github.com/acme/other" }, { ref: "dev" }, { subpath: "home" }])(
    "keeps the last good commit but marks the source pending when %j changes",
    async (change) => {
      const row = await syncedSource();
      await updateClaudeConfigSource(row.id, change);
      const after = await reload(row.id);
      expect(after.resolvedSha).toBe("a".repeat(40));
      expect(after.lastSyncedAt).toBeNull();
      expect(after.lastSyncError).toBeNull();
    },
  );

  it("leaves sync state alone when only enabled changes", async () => {
    const row = await syncedSource();
    await updateClaudeConfigSource(row.id, { enabled: false });
    const after = await reload(row.id);
    expect(after.enabled).toBe(false);
    expect(after.lastSyncedAt).not.toBeNull();
    expect(after.lastSyncError).toBe("old failure");
  });

  it("trims the ref, defaults a blank one, and normalises the subpath", async () => {
    const row = await syncedSource();
    expect((await updateClaudeConfigSource(row.id, { ref: " dev " }))?.ref).toBe("dev");
    expect((await updateClaudeConfigSource(row.id, { ref: "  " }))?.ref).toBe("main");
    expect((await updateClaudeConfigSource(row.id, { subpath: "/a/./b" }))?.subpath).toBe("a/b");
    expect((await updateClaudeConfigSource(row.id, { subpath: "." }))?.subpath).toBe(".");
  });

  it("rejects a subpath that leaves the repo, and answers null for a missing source", async () => {
    const row = await syncedSource();
    await expect(updateClaudeConfigSource(row.id, { subpath: "../x" })).rejects.toBeInstanceOf(
      ClaudeConfigInvalidInputError,
    );
    expect(
      await updateClaudeConfigSource("00000000-0000-4000-8000-000000000000", { ref: "x" }),
    ).toBeNull();
  });
});
