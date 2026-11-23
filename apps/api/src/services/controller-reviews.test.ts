import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubmitReview = vi.fn();
const mockGetWork = vi.fn();

vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../db/schema.js", () => ({ repos: {}, prReviewChatMessages: {} }));
vi.mock("./controller-service.js", () => ({
  getControllerWork: (...args: unknown[]) => mockGetWork(...args),
}));
vi.mock("./controller-access.js", () => ({
  ControllerError: class extends Error {},
  requireChange: vi.fn(),
  requireManage: vi.fn(),
  tenant: vi.fn(),
}));
vi.mock("./pr-review-service.js", () => ({
  submitReview: (...args: unknown[]) => mockSubmitReview(...args),
  ReviewScopeError: class extends Error {},
}));

import { controlControllerReview } from "./controller-reviews.js";
import type { ControllerPrincipal } from "./controller-auth.js";

describe("controlControllerReview submit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("submits as unattended so an agent cannot resolve threads", async () => {
    mockGetWork.mockResolvedValue({ kind: "review", data: { state: "ready" } });
    mockSubmitReview.mockResolvedValue({ review: { state: "submitted" }, threadActionResults: [] });
    const p = { actor: { userId: "u1", workspaceId: null } } as unknown as ControllerPrincipal;

    await controlControllerReview(p, "rev-1", "submit");

    expect(mockSubmitReview).toHaveBeenCalledWith("rev-1", "u1", { unattended: true });
  });
});
