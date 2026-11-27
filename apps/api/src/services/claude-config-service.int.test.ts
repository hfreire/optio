import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { claudeConfigSources } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import {
  ClaudeConfigInvalidInputError,
  claudeConfigGitUrl,
  createClaudeConfigSource,
  getClaudeConfigSource,
  listClaudeConfigSources,
  recordClaudeConfigSync,
  updateClaudeConfigSource,
} from "./claude-config-service.js";

async function syncedSource() {
  const ws = await insertWorkspace();
  const row = await createClaudeConfigSource({ sourceUrl: "https://github.com/acme/dot" }, ws.id);
  await recordClaudeConfigSync(
    row.id,
    { ok: true, resolvedSha: "a".repeat(40), totalSizeBytes: 1, files: [] },
    { sourceUrl: row.sourceUrl, encryptedSourceUrl: null, ref: row.ref, subpath: row.subpath },
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
  it.each([{ ref: "dev" }, { subpath: "home" }])(
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

  it("stops serving the old repo's snapshot when the source URL changes", async () => {
    const row = await syncedSource();
    await updateClaudeConfigSource(row.id, { sourceUrl: "https://github.com/acme/other" });
    const after = await reload(row.id);
    expect(after.resolvedSha).toBeNull();
    expect(after.lastSyncedAt).toBeNull();
    expect(after.lastSyncError).toBeNull();
  });

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

describe("source URL credentials", () => {
  const withToken = "https://bot:ghp_s3cret@github.com/acme/dot.git";

  it("seals a URL that signs in and keeps the credential-free form in source_url", async () => {
    const ws = await insertWorkspace();
    const created = await createClaudeConfigSource({ sourceUrl: withToken }, ws.id);
    const stored = await reload(created.id);
    expect(stored.sourceUrl).toBe("https://github.com/acme/dot.git");
    expect(stored.encryptedSourceUrl).toBeInstanceOf(Buffer);
    expect(stored.encryptedSourceUrl!.toString("latin1")).not.toContain("ghp_s3cret");
    expect(claudeConfigGitUrl(stored)).toBe(withToken);
  });

  it("seals a token passed as a query parameter", async () => {
    const ws = await insertWorkspace();
    const url = "https://git.example.com/acme/dot.git?access_token=qp-s3cret";
    const created = await createClaudeConfigSource({ sourceUrl: url }, ws.id);
    const stored = await reload(created.id);
    expect(stored.sourceUrl).toBe("https://git.example.com/acme/dot.git");
    expect(claudeConfigGitUrl(stored)).toBe(url);
  });

  it("stores a URL with no credentials in the clear only", async () => {
    const row = await syncedSource();
    const stored = await reload(row.id);
    expect(stored.encryptedSourceUrl).toBeNull();
    expect(claudeConfigGitUrl(stored)).toBe("https://github.com/acme/dot");
  });

  it("replaces the credentials on an update, and clears them with a URL that has none", async () => {
    const ws = await insertWorkspace();
    const created = await createClaudeConfigSource({ sourceUrl: withToken }, ws.id);
    const first = await reload(created.id);

    await updateClaudeConfigSource(created.id, {
      sourceUrl: "https://bot:ghp_rotated@github.com/acme/dot.git",
    });
    const rotated = await reload(created.id);
    expect(rotated.sourceUrl).toBe("https://github.com/acme/dot.git");
    expect(claudeConfigGitUrl(rotated)).toBe("https://bot:ghp_rotated@github.com/acme/dot.git");
    // A sync of the old credentials still in flight records nothing.
    expect(
      await recordClaudeConfigSync(
        created.id,
        { ok: false, error: "old" },
        { ...first, encryptedSourceUrl: first.encryptedSourceUrl },
      ),
    ).toBe(false);

    await updateClaudeConfigSource(created.id, { ref: "dev" });
    expect(claudeConfigGitUrl(await reload(created.id))).toContain("ghp_rotated");

    await updateClaudeConfigSource(created.id, { sourceUrl: "https://github.com/acme/dot.git" });
    const cleared = await reload(created.id);
    expect(cleared.encryptedSourceUrl).toBeNull();
    expect(cleared.sourceUrlIv).toBeNull();
    expect(cleared.sourceUrlAuthTag).toBeNull();
    expect(claudeConfigGitUrl(cleared)).toBe("https://github.com/acme/dot.git");
  });

  it("never returns the credentials, a row still stored in the clear included", async () => {
    const ws = await insertWorkspace();
    const created = await createClaudeConfigSource({ sourceUrl: withToken }, ws.id);
    const [legacy] = await db
      .insert(claudeConfigSources)
      .values({
        workspaceId: ws.id,
        repoUrl: "https://github.com/acme/app",
        sourceUrl: "https://bot:legacy-s3cret@github.com/acme/dot.git",
      })
      .returning();
    const answers = JSON.stringify([
      created,
      await getClaudeConfigSource(created.id),
      await getClaudeConfigSource(legacy.id),
      await listClaudeConfigSources(ws.id),
      await updateClaudeConfigSource(created.id, { enabled: false }),
      await updateClaudeConfigSource(legacy.id, { enabled: false }),
    ]);
    expect(answers).not.toMatch(/s3cret|bot[:@]/);
    expect(answers).toContain("https://github.com/acme/dot.git");
  });
});
