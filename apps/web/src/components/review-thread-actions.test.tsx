import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReviewThreadActions, threadHref } from "./review-thread-actions";

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
