import {
  SsrfError,
  assertSsrfSafe,
  isSsrfSafeHost,
  type OutboundPolicy,
  type VetOptions,
} from "@optio/shared/ssrf";

const CREDENTIAL_PARAM = /^(access_token|token|password|secret|key|auth)$/i;

/** Whether git in the API pod may read a local repository (tests, the fake runtime, an explicit opt-in). */
export function gitFileSourcesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPTIO_SKILL_ALLOW_FILE_SOURCES === "1" || env.OPTIO_RUNTIME === "fake" || !!env.VITEST;
}

const HOST = String.raw`[A-Za-z0-9][A-Za-z0-9._-]*|\[[0-9A-Fa-f:.]+\]`;
const URL_SOURCE = new RegExp(
  String.raw`^([a-z][a-z0-9+.-]*)://(?:([^@/?#\[\]]*)@)?(${HOST})(?::\d*)?(/[^?#]*)?(\?[^#]*)?$`,
  "i",
);
const SCP_SOURCE = new RegExp(String.raw`^(?:[A-Za-z0-9._-]+@)?(${HOST}):(.*)$`);

const UNREADABLE = "blocked: the source URL is not in a form Optio can vet";

/** The URL parser's canonical form of a host (`2130706433` and `127.1` become `127.0.0.1`). */
function canonicalHost(host: string): string {
  try {
    const canonical = new URL(`http://${host}/`).hostname;
    if (canonical) return canonical;
  } catch {
    // falls through
  }
  throw new SsrfError(UNREADABLE);
}

/**
 * The host git would connect to for a source: `scheme://[user@]host[:port]/…`
 * or scp-style `[user@]host:path`. Null for a local repository (`file://` or
 * a path). Throws `SsrfError` for a source with no host to vet.
 *
 * Git, curl, ssh and the URL parser each split a URL their own way
 * (`https://a\@b/`, `ssh://a?@b/`, `ssh://b%2F@a/`, `a:x@[b]:y` all name two
 * hosts), so only one strict grammar is accepted rather than any parser's
 * reading trusted.
 */
export function gitSourceHost(sourceUrl: string): string | null {
  const source = sourceUrl.trim();
  if (/[\u0000- \u007f\\]/.test(source)) throw new SsrfError(UNREADABLE);
  // `<transport>::<address>` hands the address to a remote helper.
  if (/^[a-z0-9][a-z0-9+.-]*::/i.test(source)) {
    throw new SsrfError("blocked: git remote helpers are not a source Optio can vet");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    if (/^file:/i.test(source)) return null;
    const match = URL_SOURCE.exec(source);
    if (!match) throw new SsrfError(UNREADABLE);
    const [, scheme, , host, path = "", query] = match;
    if (!/^https?$/i.test(scheme)) {
      // git percent-decodes these whole before it looks for the host, and
      // looks for `@[` anywhere in what follows.
      if (query !== undefined || source.includes("%") || path.includes("@")) {
        throw new SsrfError(UNREADABLE);
      }
    }
    return canonicalHost(host);
  }
  // git's own rule: a colon before any slash makes it scp-style, else a path.
  const colon = source.indexOf(":");
  const slash = source.indexOf("/");
  if (colon === -1 || (slash !== -1 && slash < colon)) return null;
  const match = SCP_SOURCE.exec(source);
  if (!match || match[2].includes("@")) throw new SsrfError(UNREADABLE);
  return canonicalHost(match[1]);
}

const FILE_SOURCE_BLOCKED = "blocked: local repositories are not a source this deployment allows";

/** Synchronous, from the text alone (no DNS). For Zod `.refine()`. */
export function isGitSourceUrlAllowed(sourceUrl: string, policy?: OutboundPolicy): boolean {
  try {
    const host = gitSourceHost(sourceUrl);
    return host === null ? gitFileSourcesAllowed() : isSsrfSafeHost(host, policy);
  } catch {
    return false;
  }
}

/**
 * Resolves the source's host and checks every address against the outbound
 * policy; throws `SsrfError` when blocked. Git resolves the name again when
 * it connects, so a name that answers differently the second time (DNS
 * rebinding) is not covered.
 */
export async function assertGitSourceAllowed(
  sourceUrl: string,
  opts: VetOptions & { allowFile?: boolean } = {},
): Promise<void> {
  const host = gitSourceHost(sourceUrl);
  if (host === null) {
    if (!(opts.allowFile ?? gitFileSourcesAllowed())) throw new SsrfError(FILE_SOURCE_BLOCKED);
    return;
  }
  await assertSsrfSafe(`https://${host}/`, opts);
}

/**
 * A source URL without what signs it in: userinfo and token query
 * parameters. Scp-style sources and paths carry none and come back as given.
 */
export function splitGitSourceCredentials(sourceUrl: string): {
  publicUrl: string;
  hasCredentials: boolean;
} {
  const unchanged = { publicUrl: sourceUrl, hasCredentials: false };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(sourceUrl.trim())) return unchanged;
  let url: URL;
  try {
    url = new URL(sourceUrl.trim());
  } catch {
    return unchanged;
  }
  const params = [...url.searchParams.keys()].filter((key) => CREDENTIAL_PARAM.test(key));
  if (!url.username && !url.password && params.length === 0) return unchanged;
  url.username = "";
  url.password = "";
  for (const key of params) url.searchParams.delete(key);
  return { publicUrl: url.toString(), hasCredentials: true };
}
