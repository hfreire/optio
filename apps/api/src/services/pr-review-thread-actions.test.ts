import { describe, it, expect, vi } from "vitest";
import type { GitPlatform, PrReviewThreadAction, RepoIdentifier } from "@optio/shared";
import {
  parseThreadActions,
  runThreadActions,
  hasEnabledThreadActions,
  hasPendingThreadActions,
  awaitsPerson,
  isThreadsOnly,
  threadActionSchema,
  validateThreadActions,
  ThreadActionValidationError,
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

describe("limits", () => {
  it("drops an agent action whose body is over the cap, with a warning", () => {
    warn.mockClear();
    const out = parseThreadActions(
      [
        { threadId: "big", commentId: 1, action: "reply", body: "x".repeat(20001) },
        { threadId: "ok", commentId: 2, action: "reply", body: "x".repeat(20000) },
      ],
      log,
    );
    expect(out.map((a) => a.threadId)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps at most 100 agent actions", () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      threadId: `t${i}`,
      commentId: i + 1,
      action: "resolve",
    }));
    expect(parseThreadActions(many, log)).toHaveLength(100);
  });
});

describe("validateThreadActions", () => {
  it("rejects duplicates and oversize lists with a readable message", () => {
    const a = { threadId: "t", commentId: 1, action: "resolve" as const };
    expect(() => validateThreadActions([a, a])).toThrow(ThreadActionValidationError);
    expect(() => validateThreadActions([a, a])).toThrow("Duplicate threadId");
  });

  it("names the field in the message, not raw issue JSON", () => {
    try {
      validateThreadActions([{ threadId: "t", commentId: 1, action: "reply" }]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ThreadActionValidationError);
      expect((err as Error).message).toBe("threadActions[0].body: body is required for reply");
    }
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
      listReviewThreads: vi.fn(async () => ({
        viewerLogin: "optio-bot",
        threads: [
          { threadId: "a", firstCommentId: 1, firstCommentAuthor: "optio-bot" },
          { threadId: "b", firstCommentId: 2, firstCommentAuthor: "optio-bot" },
          { threadId: "c", firstCommentId: 3, firstCommentAuthor: "optio-bot" },
          { threadId: "human", firstCommentId: 9, firstCommentAuthor: "someone" },
        ],
      })),
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

  it("accepts a switched-off reply with an empty body", () => {
    expect(
      threadActionSchema.safeParse({ threadId: "a", commentId: 1, action: "reply", enabled: false })
        .success,
    ).toBe(true);
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

  it("refuses a thread that is not on this PR, without calling reply or resolve", async () => {
    const { p, calls } = platform();
    const [r] = await runThreadActions(p, ri, 5, [
      { threadId: "other-pr", commentId: 1, action: "reply_resolve", body: "x" },
    ]);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("not on this PR") });
  });

  it("refuses a commentId that is not the first comment of the thread", async () => {
    const { p, calls } = platform();
    const [r] = await runThreadActions(p, ri, 5, [
      { threadId: "a", commentId: 99, action: "reply", body: "x" },
    ]);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("first comment") });
  });

  it("refuses a thread whose first comment is not from the authenticated account", async () => {
    const { p, calls } = platform();
    const [r] = await runThreadActions(p, ri, 5, [
      { threadId: "human", commentId: 9, action: "resolve" },
    ]);
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("not written by") });
  });

  it("compares the author case-insensitively", async () => {
    const { p, calls } = platform({
      listReviewThreads: vi.fn(async () => ({
        viewerLogin: "Optio-Bot",
        threads: [{ threadId: "a", firstCommentId: 1, firstCommentAuthor: "optio-bot" }],
      })),
    });
    await runThreadActions(p, ri, 5, [{ threadId: "a", commentId: 1, action: "resolve" }]);
    expect(calls).toEqual(["resolve:a"]);
  });

  it("still runs the valid actions when another is refused", async () => {
    const { p, calls } = platform();
    const results = await runThreadActions(p, ri, 5, [
      { threadId: "other-pr", commentId: 1, action: "resolve" },
      { threadId: "a", commentId: 1, action: "resolve" },
    ]);
    expect(calls).toEqual(["resolve:a"]);
    expect(results.map((r) => r.status)).toEqual(["failed", "done"]);
  });

  it("fails closed when the thread lookup fails or is unsupported", async () => {
    const failing = platform({
      listReviewThreads: vi.fn(async () => {
        throw new Error("lookup down");
      }),
    });
    const [r1] = await runThreadActions(failing.p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve" },
    ]);
    expect(failing.calls).toEqual([]);
    expect(r1).toMatchObject({ status: "failed", error: expect.stringContaining("lookup down") });

    const noLookup = platform({ listReviewThreads: undefined });
    const [r2] = await runThreadActions(noLookup.p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve" },
    ]);
    expect(noLookup.calls).toEqual([]);
    expect(r2).toMatchObject({ status: "skipped" });
  });

  it("looks threads up once and not at all when everything is disabled", async () => {
    const { p } = platform();
    await runThreadActions(p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve" },
      { threadId: "b", commentId: 2, action: "resolve" },
    ]);
    expect(p.listReviewThreads).toHaveBeenCalledTimes(1);
    const second = platform();
    await runThreadActions(second.p, ri, 5, [
      { threadId: "a", commentId: 1, action: "resolve", enabled: false },
    ]);
    expect(second.p.listReviewThreads).not.toHaveBeenCalled();
  });

  it("matches [bot] logins on either side, case-insensitively", async () => {
    for (const [viewer, author] of [
      ["optio[bot]", "Optio"],
      ["Optio", "optio[bot]"],
      ["optio[bot]", "optio[bot]"],
    ]) {
      const { p, calls } = platform({
        listReviewThreads: vi.fn(async () => ({
          viewerLogin: viewer,
          threads: [{ threadId: "a", firstCommentId: 1, firstCommentAuthor: author }],
        })),
      });
      await runThreadActions(p, ri, 5, [{ threadId: "a", commentId: 1, action: "resolve" }]);
      expect(calls).toEqual(["resolve:a"]);
    }
  });

  it("does not match different accounts that share a prefix", async () => {
    const { p, calls } = platform({
      listReviewThreads: vi.fn(async () => ({
        viewerLogin: "optio[bot]",
        threads: [{ threadId: "a", firstCommentId: 1, firstCommentAuthor: "optio-other" }],
      })),
    });
    await runThreadActions(p, ri, 5, [{ threadId: "a", commentId: 1, action: "resolve" }]);
    expect(calls).toEqual([]);
  });

  it("unattended: never resolves, leaves resolve and reply_resolve pending, still replies", async () => {
    const { p, calls } = platform();
    const results = await runThreadActions(
      p,
      ri,
      5,
      [
        { threadId: "a", commentId: 1, action: "resolve" },
        { threadId: "b", commentId: 2, action: "reply_resolve", body: "Fixed" },
        { threadId: "c", commentId: 3, action: "reply", body: "Why?" },
      ],
      { unattended: true },
    );
    expect(calls).toEqual(["reply:c:Why?"]);
    expect(results.map((r) => r.status)).toEqual(["skipped", "skipped", "done"]);
    expect(results[0].error).toContain("pending");
    expect(results[1].error).toContain("pending");
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

describe("thread action progress", () => {
  const base = { threadId: "a", commentId: 1 } as const;
  const both: PrReviewThreadAction = { ...base, action: "reply_resolve", body: "Fixed" };

  function platform() {
    const calls: string[] = [];
    const p = {
      listReviewThreads: async () => ({
        viewerLogin: "me",
        threads: [{ threadId: "a", firstCommentId: 1, firstCommentAuthor: "me" }],
      }),
      replyToReviewThread: async () => {
        calls.push("reply");
      },
      resolveReviewThread: async () => {
        calls.push("resolve");
      },
    } as unknown as GitPlatform;
    return { p, calls };
  }

  it("reports each step as it lands, even when a later one fails", async () => {
    const { p } = platform();
    p.resolveReviewThread = async () => {
      throw new Error("nope");
    };
    const steps: string[] = [];
    const [r] = await runThreadActions(p, ri, 5, [both], {
      onStep: (id, step) => steps.push(`${id}:${step}`),
    });
    expect(steps).toEqual(["a:replied"]);
    expect(r.status).toBe("failed");
  });

  it("skips a reply that already landed and only resolves", async () => {
    const { p, calls } = platform();
    const [r] = await runThreadActions(p, ri, 5, [{ ...both, replied: true }]);
    expect(calls).toEqual(["resolve"]);
    expect(r.status).toBe("done");
  });

  it("treats a fully applied action as done without touching the platform", async () => {
    const { p, calls } = platform();
    const listSpy = vi.fn(p.listReviewThreads);
    p.listReviewThreads = listSpy;
    const [r] = await runThreadActions(p, ri, 5, [{ ...both, replied: true, resolved: true }]);
    expect(r.status).toBe("done");
    expect(calls).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("knows which drafts still have work", () => {
    expect(hasPendingThreadActions([both])).toBe(true);
    expect(hasPendingThreadActions([{ ...both, replied: true }])).toBe(true);
    expect(hasPendingThreadActions([{ ...both, replied: true, resolved: true }])).toBe(false);
    expect(hasPendingThreadActions([{ ...both, enabled: false }])).toBe(false);
  });
});

describe("awaitsPerson", () => {
  const draft = (threadActions: PrReviewThreadAction[], over = {}) => ({
    verdict: "comment",
    summary: "",
    fileComments: [],
    threadActions,
    ...over,
  });
  const resolve: PrReviewThreadAction = { threadId: "a", commentId: 1, action: "resolve" };
  const reply: PrReviewThreadAction = { threadId: "b", commentId: 2, action: "reply", body: "x" };

  it("is true for a resolve-only draft that posts nothing", () => {
    expect(isThreadsOnly(draft([resolve]))).toBe(true);
    expect(awaitsPerson(draft([resolve]))).toBe(true);
    expect(awaitsPerson(draft([{ ...resolve, action: "reply_resolve", body: "x" }]))).toBe(true);
  });

  it("is false when an unattended reply or a review post can still happen", () => {
    expect(awaitsPerson(draft([resolve, reply]))).toBe(false);
    expect(awaitsPerson(draft([resolve], { summary: "LGTM" }))).toBe(false);
    expect(awaitsPerson(draft([resolve], { verdict: "approve" }))).toBe(false);
  });

  it("is true again once the only unattended reply has landed", () => {
    expect(awaitsPerson(draft([resolve, { ...reply, replied: true }]))).toBe(true);
  });
});
