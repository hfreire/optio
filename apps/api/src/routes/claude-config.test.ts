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
  class ClaudeConfigInvalidInputError extends Error {}
  return {
    ClaudeConfigScopeTakenError,
    ClaudeConfigInvalidInputError,
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

import {
  ClaudeConfigInvalidInputError,
  ClaudeConfigScopeTakenError,
} from "../services/claude-config-service.js";
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

  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/x.git",
    "git@gitea.git.svc.cluster.local:acme/dot.git",
    "ssh://git@10.0.0.7/acme/dot.git",
    "ext::sh -c id",
  ])("rejects the internal source %s with 400", async (sourceUrl) => {
    const created = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl },
    });
    expect(created.statusCode).toBe(400);
    mockGet.mockResolvedValue(row());
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/claude-config/c1",
      payload: { sourceUrl },
    });
    expect(patched.statusCode).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts an scp-style source on a public host", async () => {
    mockCreate.mockResolvedValue(row());
    const res = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl: "git@github.com:acme/dotclaude.git" },
    });
    expect(res.statusCode).toBe(201);
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

  it.each([
    [{ ref: "dev" }, true],
    [{ sourceUrl: "https://github.com/acme/other.git" }, true],
    [{ subpath: "home" }, true],
    [{ enabled: true }, true],
    [{ enabled: false }, false],
  ])("PATCH %j enqueues a sync: %s", async (payload, enqueues) => {
    mockGet.mockResolvedValue(row());
    mockUpdate.mockResolvedValue(row());
    const res = await app.inject({ method: "PATCH", url: "/api/claude-config/c1", payload });
    expect(res.statusCode).toBe(200);
    expect(mockEnqueue).toHaveBeenCalledTimes(enqueues ? 1 : 0);
  });

  it("maps errors: bad input 400, a source deleted meanwhile 404, anything else 500", async () => {
    mockCreate.mockRejectedValueOnce(new ClaudeConfigInvalidInputError("invalid subpath: ../x"));
    const bad = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl: "https://github.com/acme/d.git", subpath: "../x" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid subpath: ../x");

    mockCreate.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    const boom = await app.inject({
      method: "POST",
      url: "/api/claude-config",
      payload: { sourceUrl: "https://github.com/acme/d.git" },
    });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain("10.0.0.5");

    mockGet.mockResolvedValue(row());
    mockUpdate.mockResolvedValue(null);
    const gone = await app.inject({
      method: "PATCH",
      url: "/api/claude-config/c1",
      payload: { ref: "dev" },
    });
    expect(gone.statusCode).toBe(404);
  });

  it("keeps a deployment-wide source read-only for a workspace's admin", async () => {
    mockGet.mockResolvedValue(row({ workspaceId: null }));
    expect((await app.inject({ method: "GET", url: "/api/claude-config/c1" })).statusCode).toBe(
      200,
    );
    for (const [method, url, payload] of [
      ["PATCH", "/api/claude-config/c1", { enabled: false }],
      ["DELETE", "/api/claude-config/c1", undefined],
      ["POST", "/api/claude-config/c1/sync", undefined],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(404);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
