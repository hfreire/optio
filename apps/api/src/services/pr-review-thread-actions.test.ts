import { describe, it, expect, vi } from "vitest";
import type { GitPlatform, PrReviewThreadAction, RepoIdentifier } from "@optio/shared";
import {
  parseThreadActions,
  runThreadActions,
  hasEnabledThreadActions,
} from "./pr-review-thread-actions.js";

const warn = vi.fn();
const log = { warn } as never;

const ri: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://api.github.com",
};

describe("parseThreadActions", () => {
  it("returns [] for missing or non-array input", () => {
    expect(parseThreadActions(undefined, log)).toEqual([]);
    expect(parseThreadActions(null, log)).toEqual([]);
    expect(parseThreadActions({}, log)).toEqual([]);
  });

  it("keeps valid actions and defaults enabled to true", () => {
    const out = parseThreadActions(
      [
        { threadId: "PRRT_1", commentId: 11, action: "resolve" },
        { threadId: "PRRT_2", commentId: 12, action: "reply", body: "Thanks" },
        {
          threadId: "PRRT_3",
          commentId: 13,
          action: "reply_resolve",
          body: "Fixed",
          enabled: false,
        },
      ],
      log,
    );
    expect(out).toEqual([
      { threadId: "PRRT_1", commentId: 11, action: "resolve", enabled: true },
      { threadId: "PRRT_2", commentId: 12, action: "reply", body: "Thanks", enabled: true },
      { threadId: "PRRT_3", commentId: 13, action: "reply_resolve", body: "Fixed", enabled: false },
    ]);
  });

  it("drops invalid entries with a warning instead of throwing", () => {
    warn.mockClear();
    const out = parseThreadActions(
      [
        { threadId: "", commentId: 1, action: "resolve" },
        { threadId: "t", commentId: "1", action: "resolve" },
        { threadId: "t", commentId: 1, action: "delete" },
        { threadId: "t", commentId: 1, action: "reply" },
        { threadId: "t", commentId: 1, action: "reply_resolve", body: "   " },
        "nope",
        { threadId: "ok", commentId: 2, action: "resolve" },
      ],
      log,
    );
    expect(out.map((a) => a.threadId)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("drops a second action on the same thread", () => {
    const out = parseThreadActions(
      [
        { threadId: "t", commentId: 1, action: "resolve" },
        { threadId: "t", commentId: 1, action: "reply", body: "x" },
      ],
      log,
    );
    expect(out).toHaveLength(1);
    expect(out[0].action).toBe("resolve");
  });

  it("drops body on resolve", () => {
    const [a] = parseThreadActions(
      [{ threadId: "t", commentId: 1, action: "resolve", body: "ignored" }],
      log,
    );
    expect(a.body).toBeUndefined();
  });
});

describe("hasEnabledThreadActions", () => {
  it("is true only when some action is on", () => {
    const a: PrReviewThreadAction = { threadId: "t", commentId: 1, action: "resolve" };
    expect(hasEnabledThreadActions([])).toBe(false);
    expect(hasEnabledThreadActions([{ ...a, enabled: false }])).toBe(false);
    expect(hasEnabledThreadActions([a])).toBe(true);
  });
});

describe("runThreadActions", () => {
  function platform(over: Partial<GitPlatform> = {}) {
    const calls: string[] = [];
    const p = {
      replyToReviewThread: vi.fn(async (_ri, _n, t, body) => {
        calls.push(`reply:${t.threadId}:${body}`);
      }),
      resolveReviewThread: vi.fn(async (_ri, _n, id) => {
        calls.push(`resolve:${id}`);
      }),
      ...over,
    } as unknown as GitPlatform;
    return { p, calls };
  }

  it("replies before resolving for reply_resolve, in list order", async () => {
    const { p, calls } = platform();
    const results = await runThreadActions(p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve" },
      { threadId: "b", commentId: 2, action: "reply_resolve", body: "Fixed" },
      { threadId: "c", commentId: 3, action: "reply", body: "Why?" },
    ]);
    expect(calls).toEqual(["resolve:a", "reply:b:Fixed", "resolve:b", "reply:c:Why?"]);
    expect(results.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  it("skips disabled actions without calling the platform", async () => {
    const { p, calls } = platform();
    const results = await runThreadActions(p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve", enabled: false },
    ]);
    expect(calls).toEqual([]);
    expect(results).toEqual([
      { threadId: "a", action: "resolve", status: "skipped", error: "disabled" },
    ]);
  });

  it("does not resolve when the reply of a reply_resolve fails, and keeps going", async () => {
    const { p, calls } = platform({
      replyToReviewThread: vi.fn(async (_ri, _n, t) => {
        if (t.threadId === "b") throw new Error("403 forbidden");
        calls.push(`reply:${t.threadId}`);
      }),
    });
    const results = await runThreadActions(p, ri, 5, [
      { threadId: "b", commentId: 2, action: "reply_resolve", body: "x" },
      { threadId: "c", commentId: 3, action: "resolve" },
    ]);
    expect(calls).toEqual(["resolve:c"]);
    expect(results[0]).toMatchObject({ threadId: "b", status: "failed", error: "403 forbidden" });
    expect(results[1]).toMatchObject({ threadId: "c", status: "done" });
  });

  it("reports a failed resolve after a successful reply", async () => {
    const { p } = platform({
      resolveReviewThread: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const [r] = await runThreadActions(p, ri, 5, [
      { threadId: "b", commentId: 2, action: "reply_resolve", body: "x" },
    ]);
    expect(r).toMatchObject({ status: "failed", error: "boom" });
  });

  it("skips and reports on a platform without thread support", async () => {
    const p = {} as unknown as GitPlatform;
    const [r] = await runThreadActions(p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve" },
    ]);
    expect(r).toMatchObject({ status: "skipped" });
    expect(r.error).toMatch(/not supported/);
  });
});
