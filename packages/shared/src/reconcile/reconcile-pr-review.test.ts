import { describe, it, expect } from "vitest";
import { reconcilePrReview } from "./reconcile-pr-review.js";
import type { PrReviewRunSpec, PrReviewRunStatus, PrStatus, WorldSnapshot } from "./types.js";
import { PrReviewRunState, PrReviewState } from "../types/pr-review.js";

const NOW = new Date("2026-01-01T12:00:00Z");

function world(
  state: PrReviewState,
  spec: Partial<PrReviewRunSpec> = {},
  prHead: string | null = "new-sha",
  recentAutoResumeCount = 0,
): WorldSnapshot {
  const status: PrReviewRunStatus = {
    state,
    verdict: "comment",
    summary: "s",
    fileComments: null,
    submittedAt: null,
    errorMessage: null,
    controlIntent: null,
    latestRunKind: "initial",
    latestRunState: PrReviewRunState.COMPLETED,
    recentAutoRereviewCount: 0,
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    updatedAt: new Date(NOW.getTime() - 1_000),
  };
  const pr: PrStatus = {
    url: "https://github.com/acme/repo/pull/3",
    number: 3,
    state: "open",
    merged: false,
    mergeable: true,
    checksStatus: "passing",
    reviewStatus: "none",
    latestReviewComments: null,
    headSha: prHead,
  };
  return {
    now: NOW,
    run: {
      kind: "pr-review",
      ref: { kind: "pr-review", id: "review-1" },
      spec: {
        prUrl: pr.url,
        prNumber: 3,
        repoOwner: "acme",
        repoName: "repo",
        repoUrl: "https://github.com/acme/repo",
        workspaceId: null,
        origin: "auto",
        userEngaged: false,
        autoSubmitted: false,
        headSha: "old-sha",
        autoSubmitOnReady: false,
        maxAutoRereviews: 3,
        ...spec,
      },
      status,
    },
    pod: null,
    pr,
    dependencies: [],
    blockingSubtasks: [],
    capacity: { global: { running: 0, max: 5 } },
    heartbeat: { lastActivityAt: null, isStale: false, silentForMs: 0 },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 10,
      recentAutoResumeCount,
    },
    readErrors: [],
    execution: null,
  };
}

describe("reconcilePrReview — a submitted review when the PR moves on", () => {
  it("drafts a follow-up re-review for an auto review nobody is editing", () => {
    expect(reconcilePrReview(world(PrReviewState.SUBMITTED))).toMatchObject({
      kind: "launchReviewRun",
      runKind: "rereview",
      trigger: "auto_rereview_after_submit",
    });
  });

  it("only marks it stale when the person is engaged", () => {
    expect(reconcilePrReview(world(PrReviewState.SUBMITTED, { userEngaged: true }))).toMatchObject({
      kind: "transition",
      to: PrReviewState.STALE,
    });
  });

  it("only marks it stale for a manual review", () => {
    expect(reconcilePrReview(world(PrReviewState.SUBMITTED, { origin: "manual" }))).toMatchObject({
      kind: "transition",
      to: PrReviewState.STALE,
    });
  });

  it("only marks it stale once the auto re-review cap is reached", () => {
    expect(reconcilePrReview(world(PrReviewState.SUBMITTED, {}, "new-sha", 3))).toMatchObject({
      kind: "transition",
      to: PrReviewState.STALE,
    });
  });

  it("leaves it alone while the head is unchanged", () => {
    expect(reconcilePrReview(world(PrReviewState.SUBMITTED, {}, "old-sha"))).toMatchObject({
      kind: "noop",
    });
  });
});

describe("reconcilePrReview — ready and stale drafts keep their rules", () => {
  it("a ready auto draft is re-reviewed on a new head", () => {
    expect(reconcilePrReview(world(PrReviewState.READY))).toMatchObject({
      kind: "launchReviewRun",
      trigger: "auto_rereview_new_commits",
    });
  });

  it("a ready draft the person engaged with goes stale", () => {
    expect(reconcilePrReview(world(PrReviewState.READY, { userEngaged: true }))).toMatchObject({
      kind: "markStale",
    });
  });

  it("a stale engaged draft waits for the person", () => {
    expect(reconcilePrReview(world(PrReviewState.STALE, { userEngaged: true }))).toMatchObject({
      kind: "noop",
      reason: "stale_awaiting_user",
    });
  });
});
