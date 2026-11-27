import { expect, it } from "vitest";
import { hasPendingThreadActions, pendingThreadSteps } from "./pr-review.js";

const reply = { threadId: "A", commentId: 1, action: "reply_resolve", body: "ok" } as const;

it("flags an action with a reply or resolve step left", () => {
  expect(hasPendingThreadActions([{ ...reply, replied: true }])).toBe(true);
  expect(hasPendingThreadActions([{ ...reply, replied: true, resolved: true }])).toBe(false);
});

it("ignores disabled and refused actions but keeps an author mismatch pending", () => {
  expect(hasPendingThreadActions([{ ...reply, enabled: false }])).toBe(false);
  expect(hasPendingThreadActions([{ ...reply, refused: true }])).toBe(false);
  expect(hasPendingThreadActions([{ ...reply, authorMismatch: true }])).toBe(true);
});

it("reports the steps per kind", () => {
  expect(pendingThreadSteps({ ...reply, action: "reply" })).toEqual({
    reply: true,
    resolve: false,
  });
  expect(pendingThreadSteps({ ...reply, action: "resolve" })).toEqual({
    reply: false,
    resolve: true,
  });
});
