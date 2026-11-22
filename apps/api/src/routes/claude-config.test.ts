import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockEnqueue = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/claude-config-service.js", () => {
  class ClaudeConfigScopeTakenError extends Error {}
  return {
    ClaudeConfigScopeTakenError,
    listClaudeConfigSources: (...a: unknown[]) => mockList(...a),
    getClaudeConfigSource: (...a: unknown[]) => mockGet(...a),
    createClaudeConfigSource: (...a: unknown[]) => mockCreate(...a),
    updateClaudeConfigSource: (...a: unknown[]) => mockUpdate(...a),
    deleteClaudeConfigSource: (...a: unknown[]) => mockDelete(...a),
  };
});

vi.mock("../workers/claude-config-sync-worker.js", () => ({
  enqueueClaudeConfigSync: (id: string) => mockEnqueue(id),
}));

import { ClaudeConfigScopeTakenError } from "../services/claude-config-service.js";
import { claudeConfigRoutes } from "./claude-config.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  workspaceId: "ws-1",
  repoUrl: null,
  sourceUrl: "https://user:tok@github.com/acme/dotclaude.git",
  ref: "main",
  subpath: ".",
  ...over,
});

describe("claude config routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(claudeConfigRoutes);
  });

  it("creates a source, redacts the URL, and enqueues a sync", async () => {
    mockCreate.mockResolvedValue(row());
    const res = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl: "https://github.com/acme/dotclaude.git" },
    });
    expect(res.statusCode).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: "https://github.com/acme/dotclaude.git" }),
      "ws-1",
    );
    expect(mockEnqueue).toHaveBeenCalledWith("c1");
    expect(JSON.stringify(res.json())).not.toContain("tok@");
  });

  it("answers 409 when the scope already has a source", async () => {
    mockCreate.mockRejectedValue(new ClaudeConfigScopeTakenError());
    const res = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl: "https://github.com/acme/dotclaude.git" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a sourceUrl or ref git would read as an option", async () => {
    for (const payload of [
      { sourceUrl: "--upload-pack=touch /tmp/pwned" },
      { sourceUrl: "https://example.com/x.git", ref: "--output=/tmp/x" },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/claude-config", payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it("lists the workspace's sources", async () => {
    mockList.mockResolvedValue([row()]);
    const res = await app.inject({ method: "GET", url: "/api/claude-config" });
    expect(res.statusCode).toBe(200);
    expect(mockList).toHaveBeenCalledWith("ws-1");
    expect(res.json().sources).toHaveLength(1);
  });

  it("hides a source from another workspace", async () => {
    mockGet.mockResolvedValue(row({ workspaceId: "ws-other" }));
    for (const [method, url] of [
      ["GET", "/api/claude-config/c1"],
      ["DELETE", "/api/claude-config/c1"],
      ["POST", "/api/claude-config/c1/sync"],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode).toBe(404);
    }
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("syncs with 202 and deletes with 204", async () => {
    mockGet.mockResolvedValue(row());
    const sync = await app.inject({ method: "POST", url: "/api/claude-config/c1/sync" });
    expect(sync.statusCode).toBe(202);
    expect(mockEnqueue).toHaveBeenCalledWith("c1");
    const del = await app.inject({ method: "DELETE", url: "/api/claude-config/c1" });
    expect(del.statusCode).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith("c1");
  });

  it("updates a source and re-syncs", async () => {
    mockGet.mockResolvedValue(row());
    mockUpdate.mockResolvedValue(row({ ref: "dev" }));
    const res = await app.inject({
      method: "PATCH",
      url: "/api/claude-config/c1",
      payload: { ref: "dev" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith("c1", expect.objectContaining({ ref: "dev" }));
  });
});
