import { createHash } from "node:crypto";
import { z } from "zod";
import { hasPendingThreadActions as sharedHasPending, pendingThreadSteps } from "@optio/shared";
import type {
  GitPlatform,
  PrReviewHeldThread,
  PrReviewThreadAction,
  PrReviewThreadActionErrorKind,
  PrReviewThreadActionResult,
  PrReviewThreadProgress,
  PrReviewThreadWatermarks,
  RepoIdentifier,
  ReviewThreadInfo,
} from "@optio/shared";
import { logger as rootLogger } from "../logger.js";
import { classifyGitHubFailure } from "./git-platform/github.js";
import { classifyGitLabFailure } from "./git-platform/gitlab.js";

type WarnLogger = Pick<typeof rootLogger, "warn">;

export const MAX_THREAD_ACTIONS = 100;
const MAX_BODY_LENGTH = 20000;

/** Field shape shared by the REST route, the MCP tool and the service so limits can't drift. */
export const threadActionShape = z.object({
  threadId: z
    .string()
    .min(1)
    .max(500)
    .describe("GitHub review-thread node id or GitLab discussion id"),
  commentId: z.number().int().positive().describe("REST id of the thread's first comment"),
  action: z.enum(["resolve", "reply", "reply_resolve"]),
  body: z.string().max(MAX_BODY_LENGTH).optional().describe("Required for reply and reply_resolve"),
  enabled: z.boolean().optional().describe("Off skips the action on submit (default on)"),
});

export const threadActionSchema = threadActionShape
  .superRefine((a, ctx) => {
    if (a.action !== "resolve" && a.enabled !== false && !a.body?.trim()) {
      ctx.addIssue({ code: "custom", path: ["body"], message: `body is required for ${a.action}` });
    }
  })
  .transform((a): PrReviewThreadAction => ({
    threadId: a.threadId,
    commentId: a.commentId,
    action: a.action,
    ...(a.action !== "resolve" ? { body: a.body } : {}),
    enabled: a.enabled ?? true,
  }));

/** Nothing reached the platform: the review post was skipped and no thread action ran. */
export class ThreadActionsNotAppliedError extends Error {
  constructor(
    readonly results: PrReviewThreadActionResult[],
    cause?: unknown,
  ) {
    super(
      `Nothing was submitted: ${results.map((r) => `${r.threadId} ${r.status}${r.error ? ` (${r.error})` : ""}`).join("; ")}`,
      { cause },
    );
    this.name = "ThreadActionsNotAppliedError";
  }
}

export class ThreadActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadActionValidationError";
  }
}

const listSchema = z
  .array(threadActionSchema)
  .max(MAX_THREAD_ACTIONS)
  .superRefine((list, ctx) => {
    if (new Set(list.map((t) => t.threadId)).size !== list.length) {
      ctx.addIssue({ code: "custom", message: "Duplicate threadId" });
    }
  });

const formatPath = (path: Array<string | number>): string =>
  path.reduce<string>(
    (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : `${acc}.${part}`),
    "threadActions",
  );

/** Validate a person's or API client's list; throws a readable ThreadActionValidationError. */
export function validateThreadActions(raw: unknown): PrReviewThreadAction[] {
  const res = listSchema.safeParse(raw);
  if (res.success) return res.data;
  throw new ThreadActionValidationError(
    res.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`).join("; "),
  );
}

/** Strictly parse an agent's or user's `threadActions`, dropping invalid entries with a warning. */
export function parseThreadActions(
  raw: unknown,
  log: WarnLogger = rootLogger,
): PrReviewThreadAction[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PrReviewThreadAction[] = [];
  raw.forEach((entry, index) => {
    if (out.length >= MAX_THREAD_ACTIONS) {
      log.warn({ index }, "Dropping review thread action over the per-review limit");
      return;
    }
    const parsed = threadActionSchema.safeParse(entry);
    if (!parsed.success) {
      log.warn({ index, issues: parsed.error.issues }, "Dropping invalid review thread action");
      return;
    }
    if (seen.has(parsed.data.threadId)) {
      log.warn({ index, threadId: parsed.data.threadId }, "Dropping duplicate thread action");
      return;
    }
    seen.add(parsed.data.threadId);
    out.push(parsed.data);
  });
  return out;
}

export function hasEnabledThreadActions(actions: PrReviewThreadAction[]): boolean {
  return actions.some((a) => a.enabled !== false);
}

type ProgressRow = {
  threadActions: PrReviewThreadAction[] | null;
  threadActionProgress: PrReviewThreadProgress | null;
};

/** Identity of an action: progress recorded for another one (an edit) does not count. */
export function threadActionFingerprint(a: PrReviewThreadAction): string {
  return createHash("sha256")
    .update(JSON.stringify([a.threadId, a.action, a.commentId, a.body ?? ""]))
    .digest("hex");
}

function progressOf(
  progress: PrReviewThreadProgress | null | undefined,
  a: PrReviewThreadAction,
): Omit<PrReviewThreadProgress[string], "fp"> {
  const { fp, ...steps } = progress?.[a.threadId] ?? {};
  return fp === threadActionFingerprint(a) ? steps : {};
}

/** The editable list with each action's recorded progress merged in. */
export function withProgress<T extends ProgressRow>(
  row: T,
): T & { threadActions: PrReviewThreadAction[] } {
  return {
    ...row,
    threadActions: (row.threadActions ?? []).map((a) => ({
      ...a,
      ...progressOf(row.threadActionProgress, a),
    })),
  };
}

/** An enabled action with a reply or resolve step still to do. */
export function hasPendingThreadActions(row: ProgressRow): boolean {
  return sharedHasPending(withProgress(row).threadActions);
}

type DraftContent = ProgressRow & {
  verdict: string | null;
  summary: string | null;
  fileComments: Array<{ path?: string; body?: string }> | null;
};

/** The draft would post no review at all, only act on threads. */
export function isThreadsOnly(d: DraftContent): boolean {
  return (
    hasEnabledThreadActions(d.threadActions ?? []) &&
    !d.summary?.trim() &&
    !(d.fileComments ?? []).some((c) => c.path && c.body) &&
    (d.verdict === "comment" || !d.verdict)
  );
}

/** Only a person can submit this draft: an on_pr_post run would do nothing with it. */
export function awaitsPerson(d: DraftContent): boolean {
  return (
    isThreadsOnly(d) &&
    !withProgress(d).threadActions.some((a) => {
      if (a.authorMismatch) return false;
      const s = pendingThreadSteps(a);
      return s.reply || s.resolve;
    })
  );
}

const normalizeLogin = (login: string): string => login.replace(/\[bot\]$/i, "").toLowerCase();

type ThreadLookup = { viewerLogin: string; threads: ReviewThreadInfo[] };

const heldThreadSchema = z.object({
  threadId: z.string().min(1).max(500),
  commentId: z.number().int().positive(),
  reason: z.enum(["reply_cap", "truncated", "unsure"]),
});

/** The draft's `heldThreads`, or null when it reports none (the field is absent). */
export function parseHeldThreads(
  raw: unknown,
  log: WarnLogger = rootLogger,
): PrReviewHeldThread[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: PrReviewHeldThread[] = [];
  raw.forEach((entry, index) => {
    if (out.length >= MAX_THREAD_ACTIONS) return;
    const parsed = heldThreadSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.threadId)) {
      log.warn({ index }, "Dropping invalid or duplicate held thread");
      return;
    }
    seen.add(parsed.data.threadId);
    out.push(parsed.data);
  });
  return out;
}

const startedByOptio = (t: ReviewThreadInfo, postedReviewIds: number[]): boolean =>
  t.firstCommentReviewId != null && postedReviewIds.includes(t.firstCommentReviewId);

/** Each thread Optio started, mapped to its last comment. */
export function threadWatermarks(
  lookup: ThreadLookup,
  postedReviewIds: number[],
): PrReviewThreadWatermarks {
  const marks: PrReviewThreadWatermarks = {};
  for (const t of lookup.threads) {
    if (startedByOptio(t, postedReviewIds) && t.lastCommentId) marks[t.threadId] = t.lastCommentId;
  }
  return marks;
}

/** Holds stick across runs: a draft may add holds, never lift them. */
export function mergeHeldThreads(
  previous: PrReviewHeldThread[],
  drafted: PrReviewHeldThread[] | null,
): PrReviewHeldThread[] {
  const ids = new Set(previous.map((t) => t.threadId));
  return [...previous, ...(drafted ?? []).filter((t) => !ids.has(t.threadId))];
}

/** A held thread waits for a person, whatever a later draft wants to say on it. */
export function dropActionsOnHeldThreads(
  actions: PrReviewThreadAction[],
  held: PrReviewHeldThread[],
  log: WarnLogger = rootLogger,
): PrReviewThreadAction[] {
  const ids = new Set(held.map((t) => t.threadId));
  return actions.filter((a) => {
    if (!ids.has(a.threadId)) return true;
    log.warn({ threadId: a.threadId }, "Dropping thread action on a held thread");
    return false;
  });
}

/**
 * Holds still waiting for a person. Optio never posts on a held thread, so
 * a resolved or vanished thread, or the viewer's own last comment, means a
 * person took it.
 */
export function releaseHeldThreads(
  held: PrReviewHeldThread[],
  lookup: ThreadLookup,
): PrReviewHeldThread[] {
  const viewer = normalizeLogin(lookup.viewerLogin);
  const byId = new Map(lookup.threads.map((t) => [t.threadId, t]));
  return held.filter((h) => {
    const t = byId.get(h.threadId);
    return (
      !!t &&
      !t.isResolved &&
      !(t.lastCommentAuthor && normalizeLogin(t.lastCommentAuthor) === viewer)
    );
  });
}

/** Unresolved threads Optio started whose last comment is someone else's and not yet handled. */
export function threadsAwaitingFollowUp(
  lookup: ThreadLookup,
  postedReviewIds: number[],
  watermarks: PrReviewThreadWatermarks,
): ReviewThreadInfo[] {
  const viewer = normalizeLogin(lookup.viewerLogin);
  return lookup.threads.filter(
    (t) =>
      startedByOptio(t, postedReviewIds) &&
      t.isResolved === false &&
      t.lastCommentId !== undefined &&
      t.lastCommentId !== t.firstCommentId &&
      t.lastCommentId > (watermarks[t.threadId] ?? 0) &&
      !!t.lastCommentAuthor &&
      normalizeLogin(t.lastCommentAuthor) !== viewer,
  );
}

type Vetting = { kind: "refused" | "author"; message: string };

/**
 * Agent-drafted ids are untrusted: only act on this PR's threads that an
 * account Optio posts as started. A wrong thread is final; a wrong author
 * can be fixed by configuration, so a person may retry.
 */
function vetThread(
  lookup: ThreadLookup,
  a: PrReviewThreadAction,
  identities: { logins: string[]; reviewIds: number[] },
): Vetting | null {
  const thread = lookup.threads.find((t) => t.threadId === a.threadId);
  if (!thread) return { kind: "refused", message: "Refused: thread is not on this PR" };
  if (thread.firstCommentId !== a.commentId) {
    return {
      kind: "refused",
      message: "Refused: commentId is not the first comment of the thread",
    };
  }
  const own = new Set([lookup.viewerLogin, ...identities.logins].map(normalizeLogin));
  if (
    (thread.firstCommentAuthor !== null && own.has(normalizeLogin(thread.firstCommentAuthor))) ||
    (thread.firstCommentReviewId != null &&
      identities.reviewIds.includes(thread.firstCommentReviewId))
  ) {
    return null;
  }
  return {
    kind: "author",
    message: "Refused: thread was not started by an account Optio posts as",
  };
}

const platformErrorKind = (err: unknown): PrReviewThreadActionErrorKind => {
  const failure = classifyGitHubFailure(err) ?? classifyGitLabFailure(err);
  if (!failure) return "transient";
  return failure.kind === "auth" || failure.kind === "permission" ? "auth" : "rate_limit";
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type ThreadStep = "replied" | "resolved" | "refused" | "authorMismatch";

/** Run each enabled action in order; one failing never stops or undoes the others. */
export async function runThreadActions(
  platform: GitPlatform,
  ri: RepoIdentifier,
  prNumber: number,
  actions: PrReviewThreadAction[],
  opts: {
    unattended?: boolean;
    /** Lets an unattended run resolve threads; only on_pr_post auto-submits set it, never an agent. */
    resolveThreads?: boolean;
    progress?: PrReviewThreadProgress;
    /** Other accounts Optio posts as, e.g. the server token when a person submits. */
    otherLogins?: () => Promise<string[]>;
    /** GitHub reviews Optio posted, whose inline comments start Optio's own threads. */
    postedReviewIds?: number[];
    onError?: (err: unknown) => void;
    onStep?: (threadId: string, step: ThreadStep, fingerprint: string) => Promise<void> | void;
  } = {},
): Promise<PrReviewThreadActionResult[]> {
  const results: PrReviewThreadActionResult[] = [];
  const reply = platform.replyToReviewThread?.bind(platform);
  const resolve = platform.resolveReviewThread?.bind(platform);
  const list = platform.listReviewThreads?.bind(platform);
  let lookup: Promise<ThreadLookup> | null = null;
  let identities: { logins: string[]; reviewIds: number[] } | null = null;
  for (const a of actions) {
    const base = { threadId: a.threadId, action: a.action };
    if (a.enabled === false) {
      results.push({ ...base, status: "skipped", error: "disabled" });
      continue;
    }
    const done = progressOf(opts.progress, a);
    if (done.refused) {
      results.push({ ...base, status: "failed", error: "Refused earlier: not retried" });
      continue;
    }
    if (done.authorMismatch && opts.unattended) {
      results.push({
        ...base,
        status: "failed",
        error: "Left pending: thread author did not match; a person can retry",
      });
      continue;
    }
    const fp = threadActionFingerprint(a);
    const { reply: needsReply, resolve: needsResolve } = pendingThreadSteps({ ...a, ...done });
    if (!needsReply && !needsResolve) {
      results.push({ ...base, status: "done" });
      continue;
    }
    if (opts.unattended && !opts.resolveThreads && needsResolve) {
      results.push({
        ...base,
        status: "skipped",
        error: "Left pending: only a person or an on_pr_post auto-submit resolves threads",
      });
      continue;
    }
    if ((needsReply && !reply) || (needsResolve && !resolve)) {
      results.push({
        ...base,
        status: "skipped",
        error: `Thread actions not supported on ${platform.type}`,
      });
      continue;
    }
    if (!list) {
      results.push({
        ...base,
        status: "skipped",
        error: `Cannot verify review threads on ${platform.type}`,
      });
      continue;
    }
    try {
      lookup ??= list(ri, prNumber);
      const known = await lookup;
      identities ??= {
        logins: await (opts.otherLogins?.() ?? Promise.resolve([])).catch((err: unknown) => {
          rootLogger.warn({ err }, "Could not look up the server account for thread actions");
          return [];
        }),
        reviewIds: opts.postedReviewIds ?? [],
      };
      const refusal = vetThread(known, a, identities);
      if (refusal) {
        await opts.onStep?.(
          a.threadId,
          refusal.kind === "refused" ? "refused" : "authorMismatch",
          fp,
        );
        results.push({ ...base, status: "failed", error: refusal.message });
        continue;
      }
      if (needsReply && reply) {
        await reply(ri, prNumber, { threadId: a.threadId, commentId: a.commentId }, a.body ?? "");
        await opts.onStep?.(a.threadId, "replied", fp);
      }
      if (needsResolve && resolve) {
        await resolve(ri, prNumber, a.threadId);
        await opts.onStep?.(a.threadId, "resolved", fp);
      }
      results.push({ ...base, status: "done" });
    } catch (err) {
      opts.onError?.(err);
      results.push({
        ...base,
        status: "failed",
        error: errorMessage(err),
        errorKind: platformErrorKind(err),
      });
    }
  }
  return results;
}
