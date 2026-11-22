/**
 * Pure parts of the Claude config repo: which source applies to a run, how a
 * synced tree maps onto `~/.claude`, how its `settings.json` merges with the
 * adapter's, and which hook commands to check for in the pod.
 */
import { normalizeRepoUrl } from "@optio/shared";
import type { AgentContainerConfig } from "@optio/shared";

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

const CLAUDE_HOME = "/home/agent/.claude";
const CLAUDE_SETTINGS_PATH = `${CLAUDE_HOME}/settings.json`;
export const CLAUDE_CONFIG_MANIFEST_ENV = "OPTIO_CLAUDE_CONFIG_MANIFEST";
export const CLAUDE_CONFIG_REPORT_ENV = "OPTIO_CLAUDE_CONFIG_REPORT";

export interface ClaudeConfigFile {
  relativePath: string;
  content: Buffer;
  executable: boolean;
}

/** Settings keys Optio owns: the config repo never changes them. */
const OPTIO_SETTINGS_KEYS = [
  "hasCompletedOnboarding",
  "permissions",
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "forceLoginMethod",
  "forceLoginOrgUUID",
];

/** Env the pod's auth and routing depend on, which `settings.json` `env` would override. */
const AUTH_ENV_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

const AUTH_ENV_PREFIXES = ["ANTHROPIC_", "AWS_", "CLAUDE_CODE_USE_", "VERTEX_", "GOOGLE_CLOUD_"];
const PROXY_ENV_KEYS: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
]);

export const isAuthEnvKey = (key: string): boolean =>
  AUTH_ENV_KEYS.has(key) ||
  PROXY_ENV_KEYS.has(key.toUpperCase()) ||
  AUTH_ENV_PREFIXES.some((p) => key.startsWith(p));

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(low: Json, high: Json): Json {
  const out: Json = { ...low };
  for (const [key, value] of Object.entries(high)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/**
 * The config's `settings.json` under the adapter's: Optio's keys come only
 * from `base`, everything else from the config, and `env` merges with the
 * keys `isOptioEnvKey` names left to Optio.
 */
export function mergeClaudeSettings(
  base: Json,
  config: Json,
  isOptioEnvKey: (key: string) => boolean,
): Json {
  const own = { ...config };
  for (const key of OPTIO_SETTINGS_KEYS) delete own[key];
  if (isPlainObject(own.env)) {
    own.env = Object.fromEntries(Object.entries(own.env).filter(([k]) => !isOptioEnvKey(k)));
  } else {
    delete own.env;
  }
  return deepMerge(own, base);
}

export interface MappedClaudeConfig {
  setupFiles: SetupFile[];
  /** The raw `settings.json`, for `mergeClaudeSettings`. */
  settings: string | null;
  notes: string[];
}

const isHookPath = (rel: string) => rel.startsWith("hooks/") || rel.endsWith(".sh");

/**
 * A synced tree as setup files under `~/.claude`. `.git`, root-level
 * `README*` and `settings.local.json` stay out; a skill an installed skill
 * of the same name replaces is skipped with a note.
 */
export function mapClaudeConfigFiles(
  files: readonly ClaudeConfigFile[],
  installedSkillNames: ReadonlySet<string>,
): MappedClaudeConfig {
  const setupFiles: SetupFile[] = [];
  const notes: string[] = [];
  const skipped = new Set<string>();
  let settings: string | null = null;

  for (const f of files) {
    const rel = f.relativePath;
    const parts = rel.split("/");
    if (parts.some((p) => p === ".." || p === "" || p === ".git")) continue;
    if (rel === "settings.json") {
      settings = f.content.toString("utf8");
      continue;
    }
    if (rel === "settings.local.json" || rel === ".optio-config-manifest") {
      continue;
    }
    if (parts.length === 1 && /^readme/i.test(rel)) continue;
    if (parts[0] === "skills" && parts.length > 2 && installedSkillNames.has(parts[1])) {
      if (!skipped.has(parts[1])) {
        skipped.add(parts[1]);
        notes.push(
          `Warning: skill '${parts[1]}' from the Claude config repo skipped; an installed skill with that name wins`,
        );
      }
      continue;
    }
    setupFiles.push({
      path: `${CLAUDE_HOME}/${rel}`,
      content: "",
      contentBase64: f.content.toString("base64"),
      executable: f.executable || isHookPath(rel),
    });
  }
  return { setupFiles, settings, notes };
}

const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ":",
  ".",
  "[",
  "[[",
  "cd",
  "echo",
  "eval",
  "exec",
  "exit",
  "export",
  "false",
  "printf",
  "set",
  "source",
  "test",
  "true",
]);
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function words(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
    }
  }
  if (started || current) out.push(current);
  return out;
}

function firstExecutable(command: string, depth = 0): string | null {
  const w = words(command);
  let i = 0;
  while (w[i] === "env" || ASSIGNMENT.test(w[i] ?? "")) i++;
  const exe = w[i];
  if (!exe) return null;
  if (SHELLS.has(exe) && /^-\w*c$/.test(w[i + 1] ?? "") && w[i + 2] && depth < 2) {
    return firstExecutable(w[i + 2], depth + 1);
  }
  if (SHELL_BUILTINS.has(exe)) return null;
  if (exe.includes("$") && !/^\$(\{HOME\}|HOME)\//.test(exe)) return null;
  return exe;
}

export interface HookExecutable {
  event: string;
  exe: string;
}

/** The executable of each `command` hook in a settings object, best effort. */
export function hookExecutables(settings: Json): HookExecutable[] {
  const out: HookExecutable[] = [];
  const seen = new Set<string>();
  if (!isPlainObject(settings.hooks)) return out;
  for (const [event, matchers] of Object.entries(settings.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hooks = isPlainObject(matcher) ? matcher.hooks : null;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (!isPlainObject(hook) || hook.type !== "command" || typeof hook.command !== "string") {
          continue;
        }
        const exe = firstExecutable(hook.command);
        if (exe && !seen.has(exe)) {
          seen.add(exe);
          out.push({ event, exe });
        }
      }
    }
  }
  return out;
}

/** What the pod's setup script logs after writing the files (`REPORT_CLAUDE_CONFIG`). */
export function claudeConfigReport(
  notes: readonly string[],
  executables: readonly HookExecutable[],
): string | null {
  if (notes.length === 0 && executables.length === 0) return null;
  return Buffer.from(JSON.stringify({ notes, executables })).toString("base64");
}

interface SourceKey {
  repoUrl: string | null;
  workspaceId: string | null;
}

/**
 * The source for a run: the repo's own replaces the workspace's. Within a
 * level, the caller's workspace beats a deployment-wide (null workspace) row.
 */
export function selectClaudeConfigSource<T extends SourceKey>(
  sources: readonly T[],
  repoUrl: string | null,
  workspaceId: string | null,
): T | null {
  let best: T | null = null;
  let bestRank = -1;
  for (const s of sources) {
    if (s.workspaceId && s.workspaceId !== workspaceId) continue;
    if (s.repoUrl && (!repoUrl || normalizeRepoUrl(s.repoUrl) !== normalizeRepoUrl(repoUrl))) {
      continue;
    }
    const rank = (s.repoUrl ? 2 : 0) + (s.workspaceId ? 1 : 0);
    if (rank > bestRank) {
      best = s;
      bestRank = rank;
    }
  }
  return best;
}

/** Value of `OPTIO_CLAUDE_CONFIG_MANIFEST`: what this run injects, for `PRUNE_CLAUDE_CONFIG`. */
export function claudeConfigManifestEnv(paths: readonly string[]): string {
  return Buffer.from(JSON.stringify({ paths })).toString("base64");
}

export interface AppliedClaudeConfig {
  /** Injected paths relative to `~/.claude`; settings.json only when no adapter wrote it. */
  manifest: string[];
  setupFiles: SetupFile[];
  /** Value of `OPTIO_CLAUDE_CONFIG_REPORT`, null when there is nothing to log. */
  report: string | null;
}

function parseSettings(raw: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The run's setup files with the config repo's applied: its files under
 * `~/.claude`, its `settings.json` merged into the adapter's (or into a bare
 * `hasCompletedOnboarding` when the runtime has no adapter step).
 */
export function applyClaudeConfig(
  existing: readonly SetupFile[],
  files: readonly ClaudeConfigFile[],
  installedSkillNames: ReadonlySet<string>,
  isOptioEnvKey: (key: string) => boolean,
): AppliedClaudeConfig {
  const mapped = mapClaudeConfigFiles(files, installedSkillNames);
  const notes = [...mapped.notes];
  const setupFiles = [...existing];
  let executables: HookExecutable[] = [];
  let ownsSettings = false;

  if (mapped.settings !== null) {
    const config = parseSettings(mapped.settings);
    if (!config) {
      notes.push("Warning: settings.json in the Claude config repo is not a JSON object; ignored");
    } else {
      const at = setupFiles.findIndex((f) => f.path === CLAUDE_SETTINGS_PATH);
      const base = (at >= 0 ? parseSettings(setupFiles[at].content) : null) ?? {
        hasCompletedOnboarding: true,
      };
      const merged = mergeClaudeSettings(base, config, isOptioEnvKey);
      const settingsFile: SetupFile = {
        path: CLAUDE_SETTINGS_PATH,
        content: JSON.stringify(merged),
      };
      if (at >= 0) setupFiles[at] = settingsFile;
      else setupFiles.push(settingsFile);
      executables = hookExecutables(merged);
      if (at < 0) ownsSettings = true;
    }
  }
  setupFiles.push(...mapped.setupFiles);
  const manifest = mapped.setupFiles.map((f) => f.path.slice(CLAUDE_HOME.length + 1));
  if (ownsSettings) manifest.push("settings.json");
  return { setupFiles, manifest, report: claudeConfigReport(notes, executables) };
}
