/**
 * Thread follow-ups against the real database: a threads-only run renders its
 * flag, the draft's `heldThreads` land on the row and notify only when new,
 * watermarks record what a run saw, and a threads-only run never posts a review.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { GitPlatform, ReviewThreadInfo } from "@optio/shared";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews, users } from "../db/schema.js";
import { insertRepo } from "../test-utils/integration/fixtures.js";

const calls: string[] = [];
let threads: ReviewThreadInfo[] = [];
const platform = {
  type: "github",
  submitReview: vi.fn(async () => {
    calls.push("review");
    return { url: "https://github.com/o/r/pull/1#review", reviewId: 901 };
  }),
  getViewerLogin: vi.fn(async () => "optio-bot"),
  listReviewThreads: vi.fn(async () => ({ viewerLogin: "optio-bot", threads })),
  replyToReviewThread: vi.fn(async (_ri: unknown, _n: number, t: { threadId: string }) => {
    calls.push(`reply:${t.threadId}`);
    threads = threads.map((x) =>
      x.threadId === t.threadId ? { ...x, lastCommentId: 99, lastCommentAuthor: "optio-bot" } : x,
    );
  }),
  resolveReviewThread: vi.fn(async () => {}),
} as unknown as GitPlatform;

vi.mock("./git-token-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-token-service.js")>()),
  getGitPlatformForRepo: vi.fn(async () => ({
    platform,
    ri: { platform: "github", host: "github.com", owner: "o", repo: "r", apiBaseUrl: "x" },
  })),
}));

const notifyHeldThreads = vi.fn(async () => {});
vi.mock("./notification-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./notification-service.js")>()),
  notifyHeldThreads,
}));

const queueAdd = vi.fn(async () => {});
vi.mock("../workers/pr-review-worker.js", () => ({ prReviewRunQueue: { add: queueAdd } }));

const { enqueueReviewRun, failReviewForRun, parseReviewOutput, submitReview } =
  await import("./pr-review-service.js");

let n = 500;
async function insertReview(over: Partial<typeof prReviews.$inferInsert> = {}) {
  n += 1;
  const [row] = await db
    .insert(prReviews)
    .values({
      prUrl: `https://github.com/o/r/pull/${n}`,
      prNumber: n,
      repoOwner: "o",
      repoName: "r",
      repoUrl: "https://github.com/o/r",
      headSha: "abc",
      state: "reviewing",
      origin: "auto",
      postedReviewIds: [900],
      ...over,
    })
    .returning();
  return row;
}

async function insertRun(
  reviewId: string,
  kind: string,
  metadata: Record<string, unknown> = {},
  resultSummary = "Completed the review",
) {
  const [run] = await db
    .insert(prReviewRuns)
    .values({ prReviewId: reviewId, kind, resultSummary, metadata })
    .returning();
  return run;
}

const row = async (id: string) =>
  (await db.select().from(prReviews).where(eq(prReviews.id, id)))[0];

const ourThread = (threadId: string, firstCommentId: number, lastCommentId: number) => ({
  threadId,
  firstCommentId,
  firstCommentAuthor: "optio-bot",
  firstCommentReviewId: 900,
  lastCommentId,
  lastCommentAuthor: "alice",
  isResolved: false,
});

const prContext = {
  prTitle: "t",
  prBody: "",
  headSha: "abc",
  existingReviews: "",
  prComments: "",
  inlineComments: "",
};

beforeEach(() => {
  calls.length = 0;
  threads = [ourThread("A", 1, 5), ourThread("B", 2, 6)];
  notifyHeldThreads.mockClear();
  vi.mocked(platform.submitReview).mockClear();
});

describe("enqueueReviewRun", () => {
  const repoConfig = {
    defaultBranch: "main",
    reviewPromptTemplate:
      "/cross-review --pr {{PR_NUMBER}}{{THREADS_ONLY}} --draft {{OUTPUT_PATH}}",
  };

  it("renders --threads-only for a threads-only run and nothing otherwise", async () => {
    const review = await insertReview({ state: "submitted" });
    const followUp = await enqueueReviewRun(review.id, "threads-only", { prContext, repoConfig });
    expect(followUp.prompt).toBe(
      `/cross-review --pr ${review.prNumber} --threads-only --draft .optio/review-draft.json`,
    );
    const other = await insertReview({ state: "submitted" });
    const full = await enqueueReviewRun(other.id, "initial", { prContext, repoConfig });
    expect(full.prompt).toBe(
      `/cross-review --pr ${other.prNumber} --draft .optio/review-draft.json`,
    );
  });

  it("records each Optio thread's last comment at launch", async () => {
    const review = await insertReview({ state: "submitted" });
    const run = await enqueueReviewRun(review.id, "threads-only", { prContext, repoConfig });
    expect(run.metadata).toMatchObject({ threadWatermarks: { A: 5, B: 6 } });
  });

  it("keeps the default template harmless for a threads-only run", async () => {
    const review = await insertReview({ state: "submitted" });
    const run = await enqueueReviewRun(review.id, "threads-only", {
      prContext,
      repoConfig: { defaultBranch: "main" },
    });
    expect(run.prompt).toMatch(/"summary": ""/);
  });
});

describe("parseReviewOutput with held threads", () => {
  it("stores held threads and notifies about them", async () => {
    const review = await insertReview();
    const run = await insertRun(review.id, "initial");
    const held = [{ threadId: "A", commentId: 1, reason: "reply_cap" }];
    await parseReviewOutput(
      run.id,
      JSON.stringify({ verdict: "comment", summary: "s", fileComments: [], heldThreads: held }),
    );
    expect((await row(review.id)).heldThreads).toEqual(held);
    expect(notifyHeldThreads).toHaveBeenCalledWith(
      expect.objectContaining({ id: review.id }),
      held,
    );
  });

  it("notifies only about threads that were not held before", async () => {
    const before = [{ threadId: "A", commentId: 1, reason: "reply_cap" as const }];
    const review = await insertReview({ heldThreads: before });
    const run = await insertRun(review.id, "initial");
    const added = { threadId: "B", commentId: 2, reason: "unsure" };
    await parseReviewOutput(
      run.id,
      JSON.stringify({ verdict: "comment", summary: "s", heldThreads: [...before, added] }),
    );
    expect(notifyHeldThreads).toHaveBeenCalledWith(expect.anything(), [added]);

    notifyHeldThreads.mockClear();
    const again = await insertRun(review.id, "initial");
    await db.update(prReviews).set({ state: "reviewing" }).where(eq(prReviews.id, review.id));
    await parseReviewOutput(
      again.id,
      JSON.stringify({ verdict: "comment", summary: "s", heldThreads: [added] }),
    );
    expect(notifyHeldThreads).not.toHaveBeenCalled();
    expect((await row(review.id)).heldThreads).toEqual([added]);
  });

  it("drops held threads the run never saw", async () => {
    const review = await insertReview();
    const run = await insertRun(review.id, "initial", { threadWatermarks: { A: 5 } });
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "comment",
        summary: "s",
        heldThreads: [
          { threadId: "A", commentId: 1, reason: "unsure" },
          { threadId: "Invented", commentId: 3, reason: "unsure" },
        ],
      }),
    );
    expect((await row(review.id)).heldThreads.map((t) => t.threadId)).toEqual(["A"]);
  });

  it("keeps the held list when the draft does not report one", async () => {
    const before = [{ threadId: "A", commentId: 1, reason: "unsure" as const }];
    const review = await insertReview({ heldThreads: before });
    const run = await insertRun(review.id, "initial");
    await parseReviewOutput(run.id, JSON.stringify({ verdict: "comment", summary: "s" }));
    expect((await row(review.id)).heldThreads).toEqual(before);
  });
});

describe("threads-only runs", () => {
  const posted = { verdict: "approve", summary: "Looks good", fileComments: [] };

  it("record what they saw and settle back to submitted when there is nothing to post", async () => {
    const review = await insertReview({ ...posted, threadWatermarks: { A: 3, Z: 40 } });
    const run = await insertRun(review.id, "threads-only", { threadWatermarks: { A: 5, B: 6 } });
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "comment",
        summary: "",
        fileComments: [],
        threadActions: [],
        heldThreads: [{ threadId: "A", commentId: 1, reason: "reply_cap" }],
      }),
    );
    const after = await row(review.id);
    expect(after).toMatchObject({ state: "submitted", verdict: "approve", summary: "Looks good" });
    expect(after.threadWatermarks).toEqual({ A: 5, B: 6, Z: 40 });
    expect(calls).toEqual([]);
  });

  it("never touches the posted review, whatever the draft says", async () => {
    const review = await insertReview({ ...posted, origin: "manual" });
    const run = await insertRun(review.id, "threads-only");
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "approve",
        summary: "LGTM",
        fileComments: [{ path: "a.ts", line: 1, body: "x" }],
        threadActions: [{ threadId: "A", commentId: 1, action: "reply", body: "Thanks" }],
      }),
    );
    const after = await row(review.id);
    expect(after).toMatchObject({ state: "submitted", ...posted });
    expect(after.threadActions).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("auto-submits on_pr_post without a review, a held thread not blocking the reply", async () => {
    const repoUrl = `https://github.com/o/fu-${++n}`;
    await insertRepo({ repoUrl, externalReviewMode: "on_pr_post" });
    const review = await insertReview({ ...posted, repoUrl });
    const run = await insertRun(review.id, "threads-only", { threadWatermarks: { A: 5, B: 6 } });
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "comment",
        summary: "",
        fileComments: [],
        threadActions: [{ threadId: "B", commentId: 2, action: "reply", body: "Done in abc" }],
        heldThreads: [{ threadId: "A", commentId: 1, reason: "unsure" }],
      }),
    );
    const after = await row(review.id);
    expect(after).toMatchObject({ state: "submitted", summary: "Looks good" });
    expect(calls).toEqual(["reply:B"]);
    expect(after.threadWatermarks).toEqual({ A: 5, B: 99 });
  });

  it("leave the posted review submitted when the run fails, past what it saw", async () => {
    const review = await insertReview({ ...posted, threadWatermarks: { A: 9 } });
    const run = await insertRun(review.id, "threads-only", { threadWatermarks: { A: 5, B: 6 } });
    await failReviewForRun(run, "run_failed", "boom");
    expect(await row(review.id)).toMatchObject({
      state: "submitted",
      summary: "Looks good",
      threadWatermarks: { A: 9, B: 6 },
    });
  });

  it("a failed full review still fails", async () => {
    const review = await insertReview();
    const run = await insertRun(review.id, "initial");
    await failReviewForRun(run, "run_failed", "boom");
    expect((await row(review.id)).state).toBe("failed");
  });
});

describe("submit", () => {
  it("moves an acted thread's watermark past Optio's own reply", async () => {
    const review = await insertReview({
      state: "ready",
      verdict: "comment",
      summary: "",
      threadActions: [{ threadId: "A", commentId: 1, action: "reply", body: "Fixed" }],
    });
    const [user] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `it-${review.id}`,
        email: "it@example.com",
        displayName: "it",
      })
      .returning();
    await submitReview(review.id, user.id);
    expect((await row(review.id)).threadWatermarks).toEqual({ A: 99 });
  });
});
