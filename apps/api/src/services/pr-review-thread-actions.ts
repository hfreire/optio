import { z } from "zod";
import type {
  GitPlatform,
  PrReviewThreadAction,
  PrReviewThreadActionResult,
  RepoIdentifier,
  ReviewThreadInfo,
} from "@optio/shared";
import { logger as rootLogger } from "../logger.js";

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
  constructor(readonly results: PrReviewThreadActionResult[]) {
    super(
      `Nothing was submitted: ${results.map((r) => `${r.threadId} ${r.status}${r.error ? ` (${r.error})` : ""}`).join("; ")}`,
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
export const threadActionsSchema = {
  parse(raw: unknown): PrReviewThreadAction[] {
    const res = listSchema.safeParse(raw);
    if (res.success) return res.data;
    throw new ThreadActionValidationError(
      res.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`).join("; "),
    );
  },
};

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

const normalizeLogin = (login: string): string => login.replace(/\[bot\]$/i, "").toLowerCase();

type ThreadLookup = { viewerLogin: string; threads: ReviewThreadInfo[] };

/** Agent-drafted ids are untrusted: only act on this PR's threads that this account started. */
function vetThread(lookup: ThreadLookup, a: PrReviewThreadAction): string | null {
  const thread = lookup.threads.find((t) => t.threadId === a.threadId);
  if (!thread) return "Refused: thread is not on this PR";
  if (thread.firstCommentId !== a.commentId) {
    return "Refused: commentId is not the first comment of the thread";
  }
  if (
    thread.firstCommentAuthor === null ||
    normalizeLogin(thread.firstCommentAuthor) !== normalizeLogin(lookup.viewerLogin)
  ) {
    return "Refused: thread was not written by the authenticated account";
  }
  return null;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run each enabled action in order; one failing never stops or undoes the others. */
export async function runThreadActions(
  platform: GitPlatform,
  ri: RepoIdentifier,
  prNumber: number,
  actions: PrReviewThreadAction[],
  opts: { unattended?: boolean } = {},
): Promise<PrReviewThreadActionResult[]> {
  const results: PrReviewThreadActionResult[] = [];
  let lookup: Promise<ThreadLookup> | null = null;
  const lookupOnce = () => (lookup ??= platform.listReviewThreads!(ri, prNumber));
  for (const a of actions) {
    const base = { threadId: a.threadId, action: a.action };
    if (a.enabled === false) {
      results.push({ ...base, status: "skipped", error: "disabled" });
      continue;
    }
    const needsReply = a.action !== "resolve";
    const needsResolve = a.action !== "reply";
    if (opts.unattended && needsResolve) {
      results.push({
        ...base,
        status: "skipped",
        error: "Left pending: only a person submitting the review resolves threads",
      });
      continue;
    }
    if (
      (needsReply && !platform.replyToReviewThread) ||
      (needsResolve && !platform.resolveReviewThread)
    ) {
      results.push({
        ...base,
        status: "skipped",
        error: `Thread actions not supported on ${platform.type}`,
      });
      continue;
    }
    if (!platform.listReviewThreads) {
      results.push({
        ...base,
        status: "skipped",
        error: `Cannot verify review threads on ${platform.type}`,
      });
      continue;
    }
    try {
      const refusal = vetThread(await lookupOnce(), a);
      if (refusal) {
        results.push({ ...base, status: "failed", error: refusal });
        continue;
      }
      if (needsReply) {
        await platform.replyToReviewThread!(
          ri,
          prNumber,
          { threadId: a.threadId, commentId: a.commentId },
          a.body ?? "",
        );
      }
      if (needsResolve) await platform.resolveReviewThread!(ri, prNumber, a.threadId);
      results.push({ ...base, status: "done" });
    } catch (err) {
      results.push({ ...base, status: "failed", error: errorMessage(err) });
    }
  }
  return results;
}
