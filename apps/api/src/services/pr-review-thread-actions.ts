import { z } from "zod";
import type {
  GitPlatform,
  PrReviewThreadAction,
  PrReviewThreadActionResult,
  RepoIdentifier,
} from "@optio/shared";
import { logger as rootLogger } from "../logger.js";

type WarnLogger = Pick<typeof rootLogger, "warn">;

export const threadActionSchema = z
  .object({
    threadId: z.string().min(1),
    commentId: z.number().int().positive(),
    action: z.enum(["resolve", "reply", "reply_resolve"]),
    body: z.string().optional(),
    enabled: z.boolean().optional(),
  })
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

/** Strictly parse an agent's or user's `threadActions`, dropping invalid entries with a warning. */
export function parseThreadActions(
  raw: unknown,
  log: WarnLogger = rootLogger,
): PrReviewThreadAction[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PrReviewThreadAction[] = [];
  raw.forEach((entry, index) => {
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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Run each enabled action in order; one failing never stops or undoes the others. */
export async function runThreadActions(
  platform: GitPlatform,
  ri: RepoIdentifier,
  prNumber: number,
  actions: PrReviewThreadAction[],
): Promise<PrReviewThreadActionResult[]> {
  const results: PrReviewThreadActionResult[] = [];
  for (const a of actions) {
    const base = { threadId: a.threadId, action: a.action };
    if (a.enabled === false) {
      results.push({ ...base, status: "skipped", error: "disabled" });
      continue;
    }
    const needsReply = a.action !== "resolve";
    const needsResolve = a.action !== "reply";
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
    try {
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
