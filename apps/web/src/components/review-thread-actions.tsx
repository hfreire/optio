"use client";

import type {
  PrReviewHeldThread,
  PrReviewHeldThreadReason,
  PrReviewThreadAction,
  PrReviewThreadActionKind,
  PrReviewThreadActionResult,
} from "@optio/shared";
import { inputClass } from "@/components/ui/input";

const LABELS: Record<PrReviewThreadActionKind, string> = {
  resolve: "Resolve thread",
  reply: "Reply",
  reply_resolve: "Reply and resolve",
};

/** GitHub anchors a review comment as `#discussion_r<id>`, GitLab a note as `#note_<id>`. */
export function threadHref(prUrl: string, commentId: number): string {
  const anchor = prUrl.includes("/-/merge_requests/")
    ? `note_${commentId}`
    : `discussion_r${commentId}`;
  return `${prUrl.replace(/#.*$/, "")}#${anchor}`;
}

const HELD_REASONS: Record<PrReviewHeldThreadReason, string> = {
  reply_cap: "Reached the reply limit",
  truncated: "Thread too long to read in full",
  unsure: "Optio is not sure how to answer",
};

/** Threads the review agent left for a person to answer. */
export function HeldThreads({ threads, prUrl }: { threads: PrReviewHeldThread[]; prUrl: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-text-muted mb-2">Needs you</div>
      <ul className="space-y-1">
        {threads.map((t) => (
          <li
            key={t.threadId}
            className="flex items-center justify-between gap-3 p-2 rounded-md bg-bg border border-border text-xs"
          >
            <span className="text-text-muted">{HELD_REASONS[t.reason]}</span>
            <a
              href={threadHref(prUrl, t.commentId)}
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:text-primary-hover shrink-0"
            >
              Answer thread
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ReviewThreadActions({
  actions,
  prUrl,
  editable,
  onChange,
}: {
  actions: PrReviewThreadAction[];
  prUrl: string;
  editable: boolean;
  onChange: (next: PrReviewThreadAction[]) => void;
}) {
  const update = (i: number, patch: Partial<PrReviewThreadAction>) =>
    onChange(actions.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  return (
    <div>
      <div className="text-xs font-medium text-text-muted mb-2">
        Thread actions ({actions.filter((a) => a.enabled !== false).length}/{actions.length})
      </div>
      <div className="space-y-2">
        {actions.map((a, i) => {
          const enabled = a.enabled !== false;
          return (
            <div
              key={a.threadId}
              className={`flex gap-2 p-2 rounded-md bg-bg border border-border ${enabled ? "" : "opacity-60"}`}
            >
              <input
                type="checkbox"
                aria-label={`${LABELS[a.action]} on thread ${a.threadId}`}
                checked={enabled}
                disabled={!editable}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="mt-1"
              />
              <div className="flex-1 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium">{LABELS[a.action]}</span>
                  <a
                    href={threadHref(prUrl, a.commentId)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:text-primary-hover"
                  >
                    View thread
                  </a>
                </div>
                {a.action !== "resolve" && (
                  <textarea
                    value={a.body ?? ""}
                    readOnly={!editable}
                    onChange={(e) => update(i, { body: e.target.value })}
                    placeholder="Reply..."
                    rows={2}
                    className={inputClass({ size: "sm", className: "bg-bg-card resize-y" })}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A failed draft save must stop the submit, or the stored draft is posted instead of the edits. */
export async function saveBeforeSubmit(dirty: boolean, save: () => Promise<boolean>) {
  return !dirty || (await save());
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Actions the person switched off are not worth a warning; refused or deferred ones are. */
export function submitToast(results: PrReviewThreadActionResult[] | undefined): {
  kind: "success" | "warning" | "error";
  message: string;
} {
  const failed = (results ?? []).filter((r) => r.status === "failed");
  const skipped = (results ?? []).filter((r) => r.status === "skipped" && r.error !== "disabled");
  if (failed.length > 0) {
    return {
      kind: "error",
      message: `Review submitted, ${plural(failed.length, "thread action")} failed: ${failed.map((r) => r.error).join("; ")}`,
    };
  }
  if (skipped.length > 0) {
    return {
      kind: "warning",
      message: `Review submitted, ${plural(skipped.length, "thread action")} skipped: ${skipped.map((r) => r.error).join("; ")}`,
    };
  }
  return { kind: "success", message: "Review submitted" };
}
