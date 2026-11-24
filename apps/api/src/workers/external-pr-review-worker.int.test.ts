/**
 * The external-review sweep against the real database: an author's reply on a
 * thread Optio started, with no new push, launches a threads-only follow-up of
 * a submitted auto review, and only then.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPlatform, PullRequest, ReviewThreadInfo } from "@optio/shared";
import { db } from "../db/client.js";
import { prReviewRuns, prReviews, repos } from "../db/schema.js";
import { insertRepo } from "../test-utils/integration/fixtures.js";

const launchPrReview = vi.fn(async () => ({ review: {}, run: {} }));
vi.mock("../services/pr-review-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/pr-review-service.js")>()),
  launchPrReview,
}));

let prs: PullRequest[] = [];
let threads: ReviewThreadInfo[] = [];
const platform = {
  type: "github",
  listOpenPullRequests: vi.fn(async () => prs),
  listReviewThreads: vi.fn(async () => ({ viewerLogin: "optio-bot", threads })),
  getCIChecks: vi.fn(async () => []),
} as unknown as GitPlatform;

vi.mock("../services/git-token-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/git-token-service.js")>()),
  getGitPlatformForRepo: vi.fn(async () => ({
    platform,
    ri: { platform: "github", host: "github.com", owner: "o", repo: "r", apiBaseUrl: "x" },
  })),
}));

const { sweepExternalPrs } = await import("./external-pr-review-worker.js");

const PR_URL = "https://github.com/o/r/pull/7";
const anHourAgo = () => new Date(Date.now() - 3_600_000);

function openPr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: "t",
    body: "",
    state: "open",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "abc",
    baseBranch: "main",
    url: PR_URL,
    author: "alice",
    assignees: [],
    labels: [],
    createdAt: anHourAgo().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

const repliedThread: ReviewThreadInfo = {
  threadId: "T1",
  firstCommentId: 10,
  firstCommentAuthor: "optio-bot",
  firstCommentReviewId: 900,
  lastCommentId: 12,
  lastCommentAuthor: "alice",
  isResolved: false,
};

async function submittedReview(over: Partial<typeof prReviews.$inferInsert> = {}) {
  const [row] = await db
    .insert(prReviews)
    .values({
      prUrl: PR_URL,
      prNumber: 7,
      repoOwner: "o",
      repoName: "r",
      repoUrl: "https://github.com/o/r",
      headSha: "abc",
      state: "submitted",
      origin: "auto",
      postedReviewIds: [900],
      updatedAt: anHourAgo(),
      ...over,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await db.delete(prReviews);
  await db.delete(repos);
  await insertRepo({
    repoUrl: "https://github.com/o/r",
    fullName: "o/r",
    externalReviewMode: "on_pr_post",
    reviewEnabled: true,
  });
  prs = [openPr()];
  threads = [repliedThread];
  launchPrReview.mockClear();
  vi.mocked(platform.listReviewThreads!).mockClear();
});

describe("thread follow-up trigger", () => {
  it("launches a threads-only run when the author replied without pushing", async () => {
    const review = await submittedReview();
    await sweepExternalPrs();
    expect(launchPrReview).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: PR_URL,
        origin: "auto",
        runKind: "threads-only",
        seenVersion: review.updatedAt,
      }),
    );
  });

  it("ignores Optio's own reply", async () => {
    threads = [{ ...repliedThread, lastCommentAuthor: "optio-bot" }];
    await submittedReview();
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("ignores a resolved thread", async () => {
    threads = [{ ...repliedThread, isResolved: true }];
    await submittedReview();
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("ignores a reply at or below the thread's watermark", async () => {
    await submittedReview({ threadWatermarks: { T1: 12 } });
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("never replaces an unsubmitted draft", async () => {
    await submittedReview({ state: "ready" });
    await sweepExternalPrs();
    await db.delete(prReviews);
    await submittedReview({ state: "stale" });
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
    expect(platform.listReviewThreads).not.toHaveBeenCalled();
  });

  it("leaves a review the user engaged with alone", async () => {
    await submittedReview({ userEngaged: true });
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("leaves a manual review alone", async () => {
    await submittedReview({ origin: "manual" });
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("does not look up threads when the PR has not changed since the review", async () => {
    prs = [openPr({ updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })];
    await submittedReview();
    await sweepExternalPrs();
    expect(platform.listReviewThreads).not.toHaveBeenCalled();
    expect(launchPrReview).not.toHaveBeenCalled();
  });

  it("catches a reply posted while the last run was going", async () => {
    const review = await submittedReview({ updatedAt: new Date() });
    await db
      .insert(prReviewRuns)
      .values({ prReviewId: review.id, kind: "initial", createdAt: anHourAgo() });
    prs = [openPr({ updatedAt: new Date(Date.now() - 1_800_000).toISOString() })];
    await sweepExternalPrs();
    expect(launchPrReview).toHaveBeenCalledTimes(1);
  });

  it("stops after five follow-ups on one posted review", async () => {
    const review = await submittedReview();
    const at = (min: number) => new Date(Date.now() - 2 * 3_600_000 + min * 60_000);
    await db.insert(prReviewRuns).values([
      { prReviewId: review.id, kind: "initial", createdAt: at(0) },
      ...[1, 2, 3, 4, 5].map((m) => ({
        prReviewId: review.id,
        kind: "threads-only",
        createdAt: at(m),
      })),
    ]);
    await sweepExternalPrs();
    expect(launchPrReview).not.toHaveBeenCalled();
    await db.delete(prReviewRuns);
    await db.insert(prReviewRuns).values([
      { prReviewId: review.id, kind: "threads-only", createdAt: at(1) },
      { prReviewId: review.id, kind: "initial", createdAt: at(2) },
    ]);
    await sweepExternalPrs();
    expect(launchPrReview).toHaveBeenCalledTimes(1);
  });

  it("a new push takes the normal re-review path", async () => {
    prs = [openPr({ headSha: "def" })];
    await submittedReview();
    await sweepExternalPrs();
    expect(launchPrReview).toHaveBeenCalledTimes(1);
    expect(launchPrReview.mock.calls[0]).toEqual([
      expect.not.objectContaining({ runKind: "threads-only" }),
    ]);
  });
});
