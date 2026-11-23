/**
 * Review thread actions against the real database: the draft's `threadActions`
 * land on the row (invalid ones dropped), the person can switch one off, and a
 * submit posts the review (or skips it when only threads are acted on) before
 * running each enabled action, reporting every result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { GitPlatform, PrReviewThreadAction } from "@optio/shared";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews } from "../db/schema.js";

const calls: string[] = [];
const platform = {
  type: "github",
  submitReview: vi.fn(async () => {
    calls.push("review");
    return { url: "https://github.com/o/r/pull/1#review" };
  }),
  listReviewThreads: vi.fn(async () => ({
    viewerLogin: "optio-bot",
    threads: [
      { threadId: "A", firstCommentId: 1, firstCommentAuthor: "optio-bot" },
      { threadId: "B", firstCommentId: 2, firstCommentAuthor: "optio-bot" },
      { threadId: "C", firstCommentId: 3, firstCommentAuthor: "optio-bot" },
    ],
  })),
  replyToReviewThread: vi.fn(async (_ri: unknown, _n: number, t: { threadId: string }) => {
    calls.push(`reply:${t.threadId}`);
  }),
  resolveReviewThread: vi.fn(async (_ri: unknown, _n: number, id: string) => {
    calls.push(`resolve:${id}`);
  }),
} as unknown as GitPlatform;

vi.mock("./git-token-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./git-token-service.js")>()),
  getGitPlatformForRepo: vi.fn(async () => ({
    platform,
    ri: { platform: "github", host: "github.com", owner: "o", repo: "r", apiBaseUrl: "x" },
  })),
}));

const { parseReviewOutput, submitReview, updatePrReviewDraft, appendChatReplyFromRun } =
  await import("./pr-review-service.js");
const { ThreadActionsNotAppliedError } = await import("./pr-review-thread-actions.js");
const runLogService = await import("./run-log-service.js");

let n = 100;
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
      state: "ready",
      verdict: "comment",
      ...over,
    })
    .returning();
  return row;
}

const resolveA: PrReviewThreadAction = { threadId: "A", commentId: 1, action: "resolve" };
const replyResolveB: PrReviewThreadAction = {
  threadId: "B",
  commentId: 2,
  action: "reply_resolve",
  body: "Fixed",
};

beforeEach(() => {
  calls.length = 0;
  vi.mocked(platform.submitReview).mockClear();
});

describe("parseReviewOutput", () => {
  async function draftRun(over: Partial<typeof prReviews.$inferInsert> = {}, summary = "Done.") {
    const review = await insertReview({ state: "reviewing", ...over });
    const [run] = await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, resultSummary: summary })
      .returning();
    return { review, run };
  }

  it("stores valid thread actions and drops invalid ones", async () => {
    const { review, run } = await draftRun();
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "comment",
        summary: "ok",
        fileComments: [],
        threadActions: [
          { threadId: "T1", commentId: 5, action: "reply", body: "Thanks" },
          { threadId: "T2", commentId: 6, action: "reply" },
          { threadId: "T3", commentId: "7", action: "resolve" },
        ],
      }),
    );
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.threadActions).toEqual([
      { threadId: "T1", commentId: 5, action: "reply", body: "Thanks", enabled: true },
    ]);
  });

  it("keeps an empty summary when the draft only acts on threads", async () => {
    const { review, run } = await draftRun({}, "Completed the review");
    await parseReviewOutput(
      run.id,
      JSON.stringify({
        verdict: "comment",
        summary: "",
        fileComments: [],
        threadActions: [{ threadId: "T1", commentId: 5, action: "resolve" }],
      }),
    );
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.summary).toBe("");
    expect(row.threadActions).toHaveLength(1);
  });

  it("clears the previous run's thread actions when a re-review has none", async () => {
    const { review, run } = await draftRun({ threadActions: [resolveA] });
    await parseReviewOutput(run.id, JSON.stringify({ verdict: "comment", summary: "again" }));
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.threadActions).toEqual([]);
  });
});

describe("updatePrReviewDraft", () => {
  it("lets a person switch an action off and flags engagement", async () => {
    const review = await insertReview({ threadActions: [{ ...resolveA, enabled: true }] });
    const updated = await updatePrReviewDraft(review.id, {
      threadActions: [{ ...resolveA, enabled: false }],
    });
    expect(updated.threadActions).toEqual([{ ...resolveA, enabled: false }]);
    expect(updated.userEngaged).toBe(true);
  });

  it("rejects with a readable message", async () => {
    const review = await insertReview();
    await expect(
      updatePrReviewDraft(review.id, {
        threadActions: [{ threadId: "A", commentId: 1, action: "reply" }],
      }),
    ).rejects.toThrow("threadActions[0].body: body is required for reply");
  });

  it("rejects duplicate thread ids", async () => {
    const review = await insertReview();
    await expect(
      updatePrReviewDraft(review.id, { threadActions: [resolveA, resolveA] }),
    ).rejects.toThrow();
  });

  it("rejects a reply without a body", async () => {
    const review = await insertReview();
    await expect(
      updatePrReviewDraft(review.id, {
        threadActions: [{ threadId: "A", commentId: 1, action: "reply" }],
      }),
    ).rejects.toThrow();
  });
});

describe("submitReview with thread actions", () => {
  it("posts the review, then runs enabled actions in order", async () => {
    const review = await insertReview({
      summary: "Looks good",
      threadActions: [resolveA, replyResolveB],
    });
    const result = await submitReview(review.id);
    expect(calls).toEqual(["review", "resolve:A", "reply:B", "resolve:B"]);
    expect(result.reviewUrl).toContain("#review");
    expect(result.threadActionResults.map((r) => r.status)).toEqual(["done", "done"]);
    expect(result.review.state).toBe("submitted");
  });

  it("skips the review when there is no summary or file comment", async () => {
    const review = await insertReview({ summary: "", threadActions: [resolveA] });
    const result = await submitReview(review.id);
    expect(platform.submitReview).not.toHaveBeenCalled();
    expect(calls).toEqual(["resolve:A"]);
    expect(result.reviewUrl).toBeUndefined();
    expect(result.review.state).toBe("submitted");
  });

  it("still posts an approve verdict when there is nothing else to say", async () => {
    const review = await insertReview({
      summary: "",
      verdict: "approve",
      threadActions: [resolveA],
    });
    await submitReview(review.id);
    expect(calls).toEqual(["review", "resolve:A"]);
  });

  it("posts the review for file comments alone", async () => {
    const review = await insertReview({
      summary: "",
      fileComments: [{ path: "a.ts", line: 1, body: "x" }],
      threadActions: [resolveA],
    });
    await submitReview(review.id);
    expect(calls[0]).toBe("review");
  });

  it("still posts the review when no thread actions are enabled", async () => {
    const review = await insertReview({
      summary: "",
      threadActions: [{ ...resolveA, enabled: false }],
    });
    const result = await submitReview(review.id);
    expect(calls).toEqual(["review"]);
    expect(result.threadActionResults[0]).toMatchObject({ status: "skipped" });
  });

  it("a failing action is reported and does not stop or undo the others", async () => {
    vi.mocked(platform.resolveReviewThread!).mockRejectedValueOnce(new Error("403"));
    const review = await insertReview({
      summary: "s",
      threadActions: [resolveA, { threadId: "C", commentId: 3, action: "resolve" }],
    });
    const result = await submitReview(review.id);
    expect(result.threadActionResults).toMatchObject([
      { threadId: "A", status: "failed", error: "403" },
      { threadId: "C", status: "done" },
    ]);
    expect(result.review.state).toBe("submitted");
  });

  it("refuses an injected thread id and reports it", async () => {
    const review = await insertReview({
      summary: "s",
      threadActions: [{ threadId: "OTHER_PR", commentId: 1, action: "resolve" }, resolveA],
    });
    const result = await submitReview(review.id);
    expect(calls).toEqual(["review", "resolve:A"]);
    expect(result.threadActionResults).toMatchObject([
      { threadId: "OTHER_PR", status: "failed" },
      { threadId: "A", status: "done" },
    ]);
  });

  it("runs no action when posting the review fails", async () => {
    vi.mocked(platform.submitReview).mockRejectedValueOnce(new Error("head moved"));
    const review = await insertReview({ summary: "s", threadActions: [resolveA] });
    await expect(submitReview(review.id)).rejects.toThrow("head moved");
    expect(calls).toEqual([]);
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.state).toBe("ready");
  });
});

describe("submitReview and engagement", () => {
  it("an engaged auto review is settled by submitting, so a follow-up can be drafted", async () => {
    const review = await insertReview({ summary: "s", origin: "auto", userEngaged: true });
    const { review: submitted } = await submitReview(review.id);
    expect(submitted.userEngaged).toBe(false);
  });

  it("a manual review stays engaged", async () => {
    const review = await insertReview({ summary: "s", origin: "manual", userEngaged: true });
    const { review: submitted } = await submitReview(review.id);
    expect(submitted.userEngaged).toBe(true);
  });
});

describe("submitReview when nothing is posted", () => {
  it("keeps the review retryable and reports every action when all are refused", async () => {
    const review = await insertReview({
      summary: "",
      threadActions: [{ threadId: "OTHER_PR", commentId: 1, action: "resolve" }],
    });
    const err = await submitReview(review.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThreadActionsNotAppliedError);
    expect((err as InstanceType<typeof ThreadActionsNotAppliedError>).results).toMatchObject([
      { threadId: "OTHER_PR", status: "failed" },
    ]);
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.state).toBe("ready");
    expect(row.submittedAt).toBeNull();
    calls.length = 0;
    await db
      .update(prReviews)
      .set({ threadActions: [resolveA] })
      .where(eq(prReviews.id, review.id));
    await expect(submitReview(review.id)).resolves.toMatchObject({
      review: { state: "submitted" },
    });
    expect(calls).toEqual(["resolve:A"]);
  });
});

describe("submitReview unattended", () => {
  it("replies but leaves resolves pending and says so", async () => {
    const replyOnly: PrReviewThreadAction = {
      threadId: "C",
      commentId: 3,
      action: "reply",
      body: "Why?",
    };
    const review = await insertReview({
      summary: "s",
      threadActions: [resolveA, replyResolveB, replyOnly],
    });
    const result = await submitReview(review.id, undefined, { unattended: true });
    expect(calls).toEqual(["review", "reply:C"]);
    expect(result.threadActionResults.map((r) => r.status)).toEqual(["skipped", "skipped", "done"]);
    expect(result.threadActionResults[0].error).toContain("pending");
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    expect(row.threadActions).toHaveLength(3);
  });
});

describe("submitReview body", () => {
  it.each(["", "   "])("never posts an empty body for an approve (%j)", async (summary) => {
    const review = await insertReview({ summary, verdict: "approve" });
    await submitReview(review.id);
    expect(platform.submitReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ event: "APPROVE", body: expect.stringMatching(/\S/) }),
    );
  });
});

describe("overlapping submits", () => {
  it("runs the actions once", async () => {
    const review = await insertReview({ summary: "s", threadActions: [resolveA] });
    const results = await Promise.allSettled([submitReview(review.id), submitReview(review.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((c) => c === "review")).toHaveLength(1);
    expect(calls.filter((c) => c === "resolve:A")).toHaveLength(1);
  });

  it("releases the claim when posting fails so the person can retry", async () => {
    vi.mocked(platform.submitReview).mockRejectedValueOnce(new Error("boom"));
    const review = await insertReview({ summary: "s" });
    await expect(submitReview(review.id)).rejects.toThrow("boom");
    await expect(submitReview(review.id)).resolves.toMatchObject({
      review: { state: "submitted" },
    });
  });
});

describe("appendChatReplyFromRun", () => {
  async function chat(content: string, threadActions: PrReviewThreadAction[]) {
    const review = await insertReview({ state: "ready", threadActions });
    const [run] = await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, resultSummary: "ok" })
      .returning();
    await runLogService.insertLog({ prReviewRunId: run.id }, { content });
    await appendChatReplyFromRun(run.id);
    const [row] = await db.select().from(prReviews).where(eq(prReviews.id, review.id));
    return row;
  }
  const draft = (threadActions: unknown) =>
    "```json\n" + JSON.stringify({ verdict: "comment", summary: "s", threadActions }) + "\n```";

  it("keeps the valid entries when one is invalid", async () => {
    const row = await chat(
      draft([
        { threadId: "A", commentId: 1, action: "resolve" },
        { threadId: "B", commentId: "x", action: "resolve" },
      ]),
      [replyResolveB],
    );
    expect(row.threadActions).toEqual([{ ...resolveA, enabled: true }]);
  });

  it("keeps the stored actions when nothing valid comes back", async () => {
    const row = await chat(draft([{ threadId: "", commentId: 1, action: "resolve" }]), [
      replyResolveB,
    ]);
    expect(row.threadActions).toEqual([replyResolveB]);
  });
});
