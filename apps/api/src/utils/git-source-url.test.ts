import { describe, expect, it } from "vitest";
import { SsrfError, type HostResolver, type OutboundPolicy } from "@optio/shared/ssrf";
import {
  assertGitSourceAllowed,
  gitSourceHost,
  isGitSourceUrlAllowed,
  splitGitSourceCredentials,
} from "./git-source-url.js";

const policy = (over: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
  allowPrivate: false,
  allowedHosts: [],
  allowAll: false,
  ...over,
});
const strict = policy();
const publicDns: HostResolver = async () => [{ address: "140.82.112.3", family: 4 }];

describe("gitSourceHost", () => {
  it.each([
    ["https://github.com/acme/dot.git", "github.com"],
    ["https://user:tok@GitHub.com:8443/acme/dot.git", "github.com"],
    ["ssh://git@github.com:22/acme/dot.git", "github.com"],
    ["git://example.com/acme/dot.git", "example.com"],
    ["git@github.com:acme/dot.git", "github.com"],
    ["github.com:acme/dot.git", "github.com"],
    ["git@[::1]:acme/dot.git", "[::1]"],
    ["ssh://git@[fd00::1]:22/acme/dot.git", "[fd00::1]"],
    ["ssh://2130706433/acme/dot.git", "127.0.0.1"],
    ["git@127.1:acme/dot.git", "127.0.0.1"],
  ])("%s → %s", (url, host) => {
    expect(gitSourceHost(url)).toBe(host);
  });

  it.each(["file:///srv/git/dot.git", "/srv/git/dot.git", "./dot.git", "../a:b/dot.git"])(
    "%s is a local repository",
    (url) => {
      expect(gitSourceHost(url)).toBeNull();
    },
  );

  it.each([
    "https://example.com\\@10.0.0.7/acme/x.git",
    "ssh://github.com?@10.0.0.1/x.git",
    "ssh://github.com#@10.0.0.1/x.git",
    "ssh://10.0.0.1%2F@github.com/x.git",
    "git://10.0.0.1%2F@github.com/x",
    "ssh://github.com/x@[::1]/repo",
    "ssh://github.com/x%40[::1]/repo",
    "git@github.com:a@[fd00::1]:acme/x.git",
    "git@github.com:a@[::ffff:10.0.0.1]:acme/x.git",
    "[10.0.0.1:22]:acme/x.git",
    "https://a@b@10.0.0.1/x.git",
    "https://github.com\t@10.0.0.1/x.git",
    "https://github.com/x.git#frag",
  ])("%s could name two hosts", (url) => {
    expect(() => gitSourceHost(url)).toThrow(SsrfError);
    expect(isGitSourceUrlAllowed(url, policy({ allowPrivate: false }))).toBe(false);
  });

  it("keeps a token with escaped characters on an https source", () => {
    expect(gitSourceHost("https://bot:p%40ss%2Fword@github.com/acme/x.git?token=a%2Fb")).toBe(
      "github.com",
    );
  });

  it.each(["ext::sh -c 'id'", "fd::17/foo", "https://", "ssh:///path"])(
    "%s has no host to vet",
    (url) => {
      expect(() => gitSourceHost(url)).toThrow(SsrfError);
    },
  );
});

describe("isGitSourceUrlAllowed", () => {
  it.each([
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/x.git",
    "https://localhost/x.git",
    "ssh://git@localhost/x.git",
    "git@localhost:acme/x.git",
    "https://gitea.git.svc.cluster.local/acme/x.git",
    "git@gitea.git.svc.cluster.local:acme/x.git",
    "https://10.1.2.3/x.git",
    "git@10.1.2.3:acme/x.git",
    "ssh://git@192.168.1.4:2222/x.git",
    "git://[::1]/x.git",
    "ssh://2130706433/x.git",
    "ext::sh -c 'id'",
  ])("refuses %s", (url) => {
    expect(isGitSourceUrlAllowed(url, strict)).toBe(false);
  });

  it.each([
    "https://github.com/acme/x.git",
    "https://tok@github.com/acme/x.git",
    "git@github.com:acme/x.git",
    "ssh://git@gitlab.com/acme/x.git",
  ])("accepts %s", (url) => {
    expect(isGitSourceUrlAllowed(url, strict)).toBe(true);
  });

  it("follows the outbound policy", () => {
    const listed = policy({ allowedHosts: ["*.svc.cluster.local", "10.1.2.0/24", "localhost"] });
    expect(isGitSourceUrlAllowed("git@gitea.git.svc.cluster.local:acme/x.git", listed)).toBe(true);
    expect(isGitSourceUrlAllowed("https://10.1.2.3/x.git", listed)).toBe(true);
    expect(isGitSourceUrlAllowed("ssh://git@localhost/x.git", listed)).toBe(true);
    expect(isGitSourceUrlAllowed("https://10.9.9.9/x.git", listed)).toBe(false);
    const privateOk = policy({ allowPrivate: true });
    expect(isGitSourceUrlAllowed("https://10.9.9.9/x.git", privateOk)).toBe(true);
    expect(isGitSourceUrlAllowed("https://169.254.169.254/x.git", privateOk)).toBe(false);
  });
});

describe("assertGitSourceAllowed", () => {
  it("passes a public host", async () => {
    await expect(
      assertGitSourceAllowed("git@github.com:acme/x.git", {
        policy: strict,
        resolveHost: publicDns,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["https://git.example.com/x.git", "git@git.example.com:acme/x.git"])(
    "refuses %s when its name resolves to a private address",
    async (url) => {
      await expect(
        assertGitSourceAllowed(url, {
          policy: strict,
          resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
        }),
      ).rejects.toThrow(/git\.example\.com resolves to a private address/);
    },
  );

  it("refuses an address literal without resolving it", async () => {
    const resolveHost: HostResolver = async () => {
      throw new Error("resolved");
    };
    await expect(
      assertGitSourceAllowed("ssh://git@169.254.169.254/x.git", { policy: strict, resolveHost }),
    ).rejects.toThrow(/cloud metadata/);
  });

  it("allows a listed host whatever it resolves to", async () => {
    await expect(
      assertGitSourceAllowed("https://git.corp.example/x.git", {
        policy: policy({ allowedHosts: ["git.corp.example"] }),
        resolveHost: async () => [{ address: "10.0.0.5", family: 4 }],
      }),
    ).resolves.toBeUndefined();
  });

  it("leaves a name that does not resolve to git", async () => {
    await expect(
      assertGitSourceAllowed("https://nowhere.example/x.git", {
        policy: strict,
        resolveHost: async () => {
          throw Object.assign(new Error("nope"), { code: "ENOTFOUND" });
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("takes a local repository only where file sources are allowed", async () => {
    await expect(
      assertGitSourceAllowed("file:///srv/x.git", { allowFile: true }),
    ).resolves.toBeUndefined();
    await expect(assertGitSourceAllowed("file:///srv/x.git", { allowFile: false })).rejects.toThrow(
      SsrfError,
    );
    await expect(assertGitSourceAllowed("/srv/x.git", { allowFile: false })).rejects.toThrow(
      SsrfError,
    );
  });
});

describe("splitGitSourceCredentials", () => {
  it.each([
    ["https://user:tok@github.com/acme/x.git", "https://github.com/acme/x.git"],
    ["https://ghp_abc@github.com/acme/x.git", "https://github.com/acme/x.git"],
    ["https://h.example/x.git?access_token=abc&depth=1", "https://h.example/x.git?depth=1"],
    ["ssh://git@github.com/acme/x.git", "ssh://github.com/acme/x.git"],
  ])("%s keeps %s in the clear", (url, publicUrl) => {
    expect(splitGitSourceCredentials(url)).toEqual({ publicUrl, hasCredentials: true });
  });

  it.each(["https://github.com/acme/x.git", "git@github.com:acme/x.git", "/srv/x.git"])(
    "%s carries none",
    (url) => {
      expect(splitGitSourceCredentials(url)).toEqual({ publicUrl: url, hasCredentials: false });
    },
  );
});
