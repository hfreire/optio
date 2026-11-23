import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  ReviewThreadActions,
  hasPendingThreadActions,
  submitToast,
  threadHref,
} from "./review-thread-actions";

afterEach(cleanup);

const actions = [
  { threadId: "A", commentId: 11, action: "resolve" as const },
  { threadId: "B", commentId: 22, action: "reply_resolve" as const, body: "Fixed", enabled: true },
];

it("links each thread and toggles an action off", () => {
  const onChange = vi.fn();
  render(
    <ReviewThreadActions
      actions={actions}
      prUrl="https://github.com/o/r/pull/1"
      editable
      onChange={onChange}
    />,
  );
  expect(screen.getAllByText("View thread")[0]).toHaveAttribute(
    "href",
    "https://github.com/o/r/pull/1#discussion_r11",
  );
  fireEvent.click(screen.getByLabelText("Resolve thread on thread A"));
  expect(onChange).toHaveBeenCalledWith([{ ...actions[0], enabled: false }, actions[1]]);
});

it("edits a reply body and hides the body for resolve-only", () => {
  const onChange = vi.fn();
  render(
    <ReviewThreadActions
      actions={actions}
      prUrl="https://github.com/o/r/pull/1"
      editable
      onChange={onChange}
    />,
  );
  expect(screen.getAllByPlaceholderText("Reply...")).toHaveLength(1);
  fireEvent.change(screen.getByDisplayValue("Fixed"), { target: { value: "Done" } });
  expect(onChange).toHaveBeenCalledWith([actions[0], { ...actions[1], body: "Done" }]);
});

it("is read-only when not editable", () => {
  render(
    <ReviewThreadActions
      actions={actions}
      prUrl="https://github.com/o/r/pull/1"
      editable={false}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Resolve thread on thread A")).toBeDisabled();
});

it("builds GitLab note anchors", () => {
  expect(threadHref("https://gitlab.com/g/p/-/merge_requests/3", 9)).toBe(
    "https://gitlab.com/g/p/-/merge_requests/3#note_9",
  );
});

it("toasts success, a warning for skipped actions and an error for failed ones", () => {
  expect(submitToast(undefined)).toEqual({ kind: "success", message: "Review submitted" });
  expect(
    submitToast([{ threadId: "a", action: "resolve", status: "skipped", error: "disabled" }]),
  ).toEqual({ kind: "success", message: "Review submitted" });
  const warn = submitToast([
    { threadId: "a", action: "resolve", status: "done" },
    {
      threadId: "b",
      action: "resolve",
      status: "skipped",
      error: "Left pending: a person resolves",
    },
  ]);
  expect(warn.kind).toBe("warning");
  expect(warn.message).toContain("1 thread action skipped");
  expect(warn.message).toContain("Left pending");
  expect(
    submitToast([{ threadId: "a", action: "reply", status: "failed", error: "403" }]).kind,
  ).toBe("error");
});

it("flags a submitted review whose resolve is still pending", () => {
  const reply = { threadId: "A", commentId: 1, action: "reply_resolve", body: "ok" } as const;
  expect(hasPendingThreadActions([{ ...reply, replied: true }])).toBe(true);
  expect(hasPendingThreadActions([{ ...reply, replied: true, resolved: true }])).toBe(false);
  expect(hasPendingThreadActions([{ ...reply, enabled: false }])).toBe(false);
  expect(hasPendingThreadActions([{ ...reply, refused: true }])).toBe(false);
});
