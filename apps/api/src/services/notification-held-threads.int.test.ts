/** Held-thread pushes reach the workspace's admins only, with a link to the review. */
import { describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { pushSubscriptions, users, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";

vi.hoisted(() => {
  process.env.OPTIO_VAPID_PUBLIC_KEY = "pub";
  process.env.OPTIO_VAPID_PRIVATE_KEY = "priv";
  process.env.OPTIO_VAPID_SUBJECT = "mailto:it@example.com";
});

const sent: { endpoint: string; payload: string }[] = [];
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async (sub: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: sub.endpoint, payload });
    }),
  },
}));

const { notifyHeldThreads } = await import("./notification-service.js");

async function member(workspaceId: string, role: "admin" | "member", name: string) {
  const [user] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: name,
      email: `${name}@example.com`,
      displayName: name,
    })
    .returning();
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role });
  await db
    .insert(pushSubscriptions)
    .values({ userId: user.id, endpoint: `https://push/${name}`, p256dh: "k", auth: "a" });
}

describe("notifyHeldThreads", () => {
  it("pushes to each admin, not to members", async () => {
    const ws = await insertWorkspace();
    await member(ws.id, "admin", "ada");
    await member(ws.id, "member", "bob");
    await notifyHeldThreads(
      {
        id: "11111111-1111-1111-1111-111111111111",
        workspaceId: ws.id,
        prUrl: "https://github.com/o/r/pull/3",
        prNumber: 3,
        repoOwner: "o",
        repoName: "r",
      },
      [
        { threadId: "A", commentId: 1, reason: "unsure" },
        { threadId: "B", commentId: 2, reason: "reply_cap" },
      ],
    );
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push/ada"]);
    expect(JSON.parse(sent[0].payload)).toMatchObject({
      body: "2 threads on o/r#3",
      data: { eventType: "review.needs_you" },
    });
    expect(JSON.parse(sent[0].payload).data.url).toMatch(
      /\/reviews\/11111111-1111-1111-1111-111111111111$/,
    );
  });
});
