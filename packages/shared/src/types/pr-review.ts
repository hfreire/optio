/**
 * PR Review primitive — first-class sibling of Repo Tasks and Standalone
 * Tasks. A `pr_reviews` row is a review record attached to a single PR.
 * Each agent execution (initial review, re-review, chat turn) is a
 * `pr_review_runs` row.
 */

export enum PrReviewState {
  QUEUED = "queued",
  WAITING_CI = "waiting_ci",
  REVIEWING = "reviewing",
  READY = "ready",
  STALE = "stale",
  SUBMITTED = "submitted",
  CANCELLED = "cancelled",
  FAILED = "failed",
}

export enum PrReviewRunState {
  QUEUED = "queued",
  PROVISIONING = "provisioning",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export type PrReviewRunKind = "initial" | "rereview" | "chat" | "threads-only";

export type PrReviewHeldThreadReason = "reply_cap" | "truncated" | "unsure";

/** A thread the review agent left for a person to answer. */
export interface PrReviewHeldThread {
  threadId: string;
  commentId: number;
  reason: PrReviewHeldThreadReason;
}

/** Per thread, the last comment id Optio has already handled. */
export type PrReviewThreadWatermarks = Record<string, number>;

export type PrReviewVerdict = "approve" | "request_changes" | "comment";

export type PrReviewOrigin = "manual" | "auto";

export type PrReviewControlIntent = "cancel" | "rereview";

export interface PrReviewFileComment {
  path: string;
  line?: number;
  side?: string;
  body: string;
}

export type PrReviewThreadActionKind = "resolve" | "reply" | "reply_resolve";

/** An action on an existing review thread, run when the review is submitted. */
export interface PrReviewThreadAction {
  /** GitHub GraphQL review-thread node id, or GitLab discussion id. */
  threadId: string;
  /** REST id of the thread's first comment (GitHub reply target). */
  commentId: number;
  action: PrReviewThreadActionKind;
  /** Markdown; required for `reply` and `reply_resolve`. */
  body?: string;
  /** Off = skipped on submit. Absent means on. */
  enabled?: boolean;
  /** Read-only progress merged in by the API: the reply landed. */
  replied?: boolean;
  /** Read-only: the thread was resolved. */
  resolved?: boolean;
  /** Read-only: refused as not a thread on this PR with that first comment; never retried. */
  refused?: boolean;
  /** Read-only: the thread was started by an account Optio does not post as; retried by a person. */
  authorMismatch?: boolean;
}

/** Steps of an action that still have to happen; none for disabled or refused actions. */
export function pendingThreadSteps(a: PrReviewThreadAction): { reply: boolean; resolve: boolean } {
  if (a.enabled === false || a.refused) return { reply: false, resolve: false };
  return {
    reply: a.action !== "resolve" && !a.replied,
    resolve: a.action !== "reply" && !a.resolved,
  };
}

/** An enabled action with a reply or resolve step still to do. */
export function hasPendingThreadActions(actions: PrReviewThreadAction[]): boolean {
  return actions.some((a) => {
    const s = pendingThreadSteps(a);
    return s.reply || s.resolve;
  });
}

/** Which steps of each action ran, keyed by threadId; kept apart from the editable list. */
export type PrReviewThreadProgress = Record<
  string,
  {
    /** Identity of the action the steps belong to; a mismatch means the action was edited. */
    fp?: string;
    replied?: boolean;
    resolved?: boolean;
    refused?: boolean;
    authorMismatch?: boolean;
  }
>;

export type PrReviewThreadActionErrorKind = "rate_limit" | "auth" | "transient";

export interface PrReviewThreadActionResult {
  threadId: string;
  action: PrReviewThreadActionKind;
  status: "done" | "failed" | "skipped";
  error?: string;
  errorKind?: PrReviewThreadActionErrorKind;
}

/**
 * Valid state transitions for `pr_reviews`. Unlike repo tasks, pr_reviews
 * can cycle back to reviewing from submitted/stale when the PR advances
 * and the user asks for a re-review.
 */
const PR_REVIEW_TRANSITIONS: Record<PrReviewState, PrReviewState[]> = {
  [PrReviewState.QUEUED]: [
    PrReviewState.WAITING_CI,
    PrReviewState.REVIEWING,
    PrReviewState.CANCELLED,
    PrReviewState.FAILED,
  ],
  [PrReviewState.WAITING_CI]: [
    PrReviewState.REVIEWING,
    PrReviewState.CANCELLED,
    PrReviewState.FAILED,
  ],
  [PrReviewState.REVIEWING]: [PrReviewState.READY, PrReviewState.FAILED, PrReviewState.CANCELLED],
  [PrReviewState.READY]: [
    PrReviewState.SUBMITTED,
    PrReviewState.STALE,
    PrReviewState.REVIEWING, // user-initiated rereview
    PrReviewState.CANCELLED,
  ],
  [PrReviewState.STALE]: [
    PrReviewState.REVIEWING, // auto or manual rereview
    PrReviewState.SUBMITTED,
    PrReviewState.CANCELLED,
  ],
  [PrReviewState.SUBMITTED]: [
    PrReviewState.STALE, // PR got new commits after submit
    PrReviewState.REVIEWING, // re-review fired
  ],
  [PrReviewState.CANCELLED]: [],
  [PrReviewState.FAILED]: [
    PrReviewState.QUEUED, // user retry
    PrReviewState.CANCELLED,
  ],
};

export function canTransitionPrReview(from: PrReviewState, to: PrReviewState): boolean {
  return PR_REVIEW_TRANSITIONS[from].includes(to);
}

export const NON_TERMINAL_PR_REVIEW_STATES: PrReviewState[] = [
  PrReviewState.QUEUED,
  PrReviewState.WAITING_CI,
  PrReviewState.REVIEWING,
  PrReviewState.READY,
  PrReviewState.STALE,
  PrReviewState.SUBMITTED, // submitted isn't fully terminal — PR may advance
  PrReviewState.FAILED, // failed can be retried
];
