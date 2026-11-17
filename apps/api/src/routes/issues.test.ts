import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockPlatform = {
  type: "github",
  listIssues: vi.fn().mockResolvedValue([]),
  createLabel: vi.fn().mockResolvedValue(undefined),
  addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
  getIssueComments: vi.fn().mockResolvedValue([]),
  createIssueComment: vi.fn().mockResolvedValue(undefined),
};
const mockGetGitPlatformForRepo = vi.fn().mockResolvedValue({
  platform: mockPlatform,
  ri: {
    platform: "github",
    host: "github.com",
    owner: "org",
    repo: "repo",
    apiBaseUrl: "https://api.github.com",
  },
});
vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

// Default return: an empty chainable so tests that don't script every db.select() call
// (e.g. the new ticket_providers fan-out) get an empty result instead of undefined.
const emptyChain = () => ({
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
});
const mockDbSelect = vi.fn();
vi.mock("../db/client.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock("../db/schema.js", () => ({
  repos: { id: "id", workspaceId: "workspaceId" },
  tasks: {
    ticketSource: "ticketSource",
    ticketExternalId: "ticketExternalId",
    id: "id",
    state: "state",
    workspaceId: "workspaceId",
  },
  ticketProviders: { id: "id", source: "source", enabled: "enabled" },
}));

vi.mock("@optio/ticket-providers", () => ({
  getTicketProvider: vi.fn(() => ({
    fetchActionableTickets: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../services/secret-service.js", () => ({
  retrieveSecret: vi.fn().mockRejectedValue(new Error("no secret")),
}));

vi.mock("../services/github-token-service.js", () => ({
  getGitHubToken: vi.fn().mockResolvedValue(null),
}));

vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockCreateTask = vi.fn();
const mockTransitionTask = vi.fn();
vi.mock("../services/task-service.js", () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { issueRoutes } from "./issues.js";
import { clearIssueListCache, invalidateIssueListRepo } from "../services/issue-list-cache.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(issueRoutes);
}

describe("GET /api/issues", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearIssueListCache();
    mockDbSelect.mockImplementation(emptyChain);
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty issues when no repos exist", async () => {
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(repoChain).mockReturnValueOnce(taskChain);

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });

  it("includes author username in issue response", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "org",
        repo: "repo",
        apiBaseUrl: "https://api.github.com",
      },
    });

    // repos query returns one repo
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          fullName: "org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    // tasks query returns empty
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(repoChain).mockReturnValueOnce(taskChain);

    // Mock platform listIssues response
    mockPlatform.listIssues.mockResolvedValue([
      {
        id: 1,
        number: 42,
        title: "Test issue",
        body: "Test body",
        state: "open",
        url: "https://github.com/org/repo/issues/42",
        labels: [],
        author: "testauthor",
        assignee: null,
        isPullRequest: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    const { issues } = res.json();
    expect(issues).toHaveLength(1);
    expect(issues[0].author).toBe("testauthor");
    expect(issues[0].number).toBe(42);
  });

  it("reports a repo whose issues could not be fetched instead of silently dropping it", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "org",
        repo: "repo",
        apiBaseUrl: "https://api.github.com",
      },
    });
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          fullName: "org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(repoChain).mockReturnValueOnce(taskChain);
    const err = Object.assign(
      new Error('GitHub API error 401: {\n  "message": "Bad credentials"\n}'),
      {
        status: 401,
      },
    );
    mockPlatform.listIssues.mockRejectedValue(err);

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issues).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      source: "github",
      name: "org/repo",
      repoId: "repo-1",
      status: 401,
    });
    expect(body.errors[0].message).toContain("GITHUB_TOKEN");
    expect(body.errors[0].message).not.toContain("Bad credentials");
  });

  it("reports a repo with no git token configured", async () => {
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("no token"));
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          fullName: "org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(repoChain).mockReturnValueOnce(taskChain);

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    expect(res.json().errors).toEqual([
      expect.objectContaining({ name: "org/repo", status: null }),
    ]);
    expect(res.json().errors[0].message).toMatch(/No GitHub token/);
  });

  it("returns null author when issue has no user", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "org",
        repo: "repo",
        apiBaseUrl: "https://api.github.com",
      },
    });

    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          fullName: "org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValueOnce(repoChain).mockReturnValueOnce(taskChain);

    mockPlatform.listIssues.mockResolvedValue([
      {
        id: 2,
        number: 43,
        title: "No author issue",
        body: "",
        state: "open",
        url: "https://github.com/org/repo/issues/43",
        labels: [],
        author: "",
        assignee: null,
        isPullRequest: false,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      },
    ]);

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    const { issues } = res.json();
    expect(issues).toHaveLength(1);
    expect(issues[0].author).toBeNull();
  });

  it("returns empty issues when no repos are configured", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "org",
        repo: "repo",
        apiBaseUrl: "https://api.github.com",
      },
    });

    // repos query returns empty
    const repoChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    // tasks query
    const taskChain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect
      .mockReturnValueOnce(repoChain) // repos query (with workspace filter)
      .mockReturnValueOnce(taskChain); // tasks query

    const res = await app.inject({ method: "GET", url: "/api/issues" });

    expect(res.statusCode).toBe(200);
    expect(res.json().issues).toEqual([]);
  });
});

describe("GET /api/issues cache", () => {
  let app: FastifyInstance;
  const ri = {
    platform: "github",
    host: "github.com",
    owner: "org",
    repo: "repo",
    apiBaseUrl: "https://api.github.com",
  };
  const issue = (number: number) => ({
    id: number,
    number,
    title: `Issue ${number}`,
    body: "",
    state: "open",
    url: `https://github.com/org/repo/issues/${number}`,
    labels: [],
    author: "jon",
    assignee: null,
    isPullRequest: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
  });
  const chain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  });
  const repoRow = {
    id: "repo-1",
    repoUrl: "https://github.com/org/repo",
    fullName: "org/repo",
    workspaceId: "ws-1",
  };
  const listNumbers = async () => {
    mockDbSelect.mockReturnValueOnce(chain([repoRow])).mockReturnValueOnce(chain([]));
    const res = await app.inject({ method: "GET", url: "/api/issues" });
    expect(res.statusCode).toBe(200);
    return res.json().issues.map((i: { number: number }) => i.number);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    clearIssueListCache();
    mockDbSelect.mockImplementation(emptyChain);
    mockGetGitPlatformForRepo.mockResolvedValue({ platform: mockPlatform, ri });
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers a repeat read from the cache", async () => {
    mockPlatform.listIssues.mockResolvedValueOnce([issue(1)]);
    expect(await listNumbers()).toEqual([1]);
    expect(await listNumbers()).toEqual([1]);
    expect(mockPlatform.listIssues).toHaveBeenCalledTimes(1);
  });

  it("serves a stale list at once and re-reads it in the background", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockPlatform.listIssues.mockResolvedValueOnce([issue(1)]);
    await listNumbers();
    vi.setSystemTime(Date.now() + 31_000);

    let release!: (issues: unknown[]) => void;
    mockPlatform.listIssues.mockReturnValueOnce(new Promise((r) => (release = r)));
    expect(await listNumbers()).toEqual([1]);
    expect(mockPlatform.listIssues).toHaveBeenCalledTimes(2);

    release([issue(1), issue(2)]);
    await vi.waitFor(async () => expect(await listNumbers()).toEqual([1, 2]));
    expect(mockPlatform.listIssues).toHaveBeenCalledTimes(2);
  });

  it("waits for the platform once the cached list is too old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockPlatform.listIssues.mockResolvedValueOnce([issue(1)]);
    await listNumbers();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    mockPlatform.listIssues.mockResolvedValueOnce([issue(2)]);
    expect(await listNumbers()).toEqual([2]);
  });

  it("re-reads a repo once it's invalidated", async () => {
    mockPlatform.listIssues.mockResolvedValueOnce([issue(1)]);
    await listNumbers();
    invalidateIssueListRepo("https://github.com/org/repo.git");
    mockPlatform.listIssues.mockResolvedValueOnce([issue(2)]);
    expect(await listNumbers()).toEqual([2]);
  });
});

describe("POST /api/issues/assign", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDbSelect.mockImplementation(emptyChain);
    app = await buildTestApp();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 404 when repo not found", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "nonexistent",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 503 when no git token is configured", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          workspaceId: "ws-1",
        },
      ]),
    };
    mockDbSelect.mockReturnValue(chainable);
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No token"));

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "repo-1",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("No git token");
  });

  it("returns 404 for repo in different workspace", async () => {
    const chainable = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "repo-1",
          repoUrl: "https://github.com/org/repo",
          workspaceId: "ws-other",
        },
      ]),
    };
    mockDbSelect.mockReturnValue(chainable);

    const res = await app.inject({
      method: "POST",
      url: "/api/issues/assign",
      payload: {
        issueNumber: 42,
        repoId: "repo-1",
        title: "Fix bug",
        body: "Bug description",
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
