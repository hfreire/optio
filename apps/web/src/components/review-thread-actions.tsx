"use client";

import type {
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

/** An enabled action whose reply or resolve step has not happened yet. */
export function hasPendingThreadActions(actions: PrReviewThreadAction[]): boolean {
  return actions.some(
    (a) =>
      a.enabled !== false &&
      !a.refused &&
      ((a.action !== "resolve" && !a.replied) || (a.action !== "reply" && !a.resolved)),
  );
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
