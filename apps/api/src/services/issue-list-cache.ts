import { normalizeRepoUrl, type Issue } from "@optio/shared";
import { logger } from "../logger.js";

/**
 * The Inbox's per-repository issue lists, per API instance like every cache
 * here. Fresh for `FRESH_MS`; up to `STALE_MS` old a read is answered from
 * the cache while the platform is re-read in the background. Apart from the
 * route so the webhook receivers can drop an entry without loading it.
 */

const FRESH_MS = 30_000;
const STALE_MS = 10 * 60_000;

interface Entry {
  at: number;
  issues: Issue[];
}

const cache = new Map<string, Entry>();
const inFlight = new Map<string, Promise<Issue[]>>();

/** Keyed by user too: each reads the repo with its own token. */
export const issueListKey = (userId: string | null | undefined, repoUrl: string, state: string) =>
  `${userId ?? "-"}:${state}:${normalizeRepoUrl(repoUrl)}`;

export function cachedIssueList(key: string, load: () => Promise<Issue[]>): Promise<Issue[]> {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FRESH_MS) return Promise.resolve(hit.issues);
  const read = inFlight.get(key) ?? reread(key, load);
  if (hit && age < STALE_MS) {
    read.catch((err) => logger.warn({ err, key }, "issues: background refresh failed"));
    return Promise.resolve(hit.issues);
  }
  return read;
}

function reread(key: string, load: () => Promise<Issue[]>): Promise<Issue[]> {
  const p = load()
    .then((issues) => {
      cache.set(key, { at: Date.now(), issues });
      return issues;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** The repo's issues changed (a webhook, or Optio labelled one): the next read goes to the platform. */
export function invalidateIssueListRepo(repoUrl: string): void {
  const suffix = `:${normalizeRepoUrl(repoUrl)}`;
  for (const key of cache.keys()) if (key.endsWith(suffix)) cache.delete(key);
}

/** For tests. */
export function clearIssueListCache(): void {
  cache.clear();
  inFlight.clear();
}
