/**
 * Model providers: a saved way for an agent CLI to reach its models other
 * than its default sign-in — Amazon Bedrock (Claude Code and Codex) or a
 * LiteLLM proxy (Claude Code, through its Anthropic-compatible endpoint).
 *
 * Set up once (Settings → Model providers), owned by the organization (the
 * workspace) or by one person, then picked per piece of work: the work's
 * agent options carry `modelProvider: <id>` and the model field holds the
 * provider's own model id (`us.anthropic.claude-opus-5-5`, `openai.gpt-5.4`).
 *
 * Where the run happens decides the credentials:
 * - a pod uses what the provider stores on the server (AWS access keys or a
 *   Bedrock API key, encrypted) or the pod's own IAM role (`ambient`);
 * - a machine uses its own AWS credentials (an AWS profile there, by name),
 *   or for LiteLLM a key from one of its own environment variables.
 *   No credential ever leaves the server for a machine.
 */

import type { WorkspaceRole } from "./workspace.js";

export const MODEL_PROVIDER_KINDS = ["bedrock", "litellm"] as const;
export type ModelProviderKind = (typeof MODEL_PROVIDER_KINDS)[number];

/** The agent runtimes a model provider can serve. */
export const MODEL_PROVIDER_AGENTS = ["claude-code", "codex"] as const;
export type ModelProviderAgent = (typeof MODEL_PROVIDER_AGENTS)[number];

export function isModelProviderAgent(agentType: string): agentType is ModelProviderAgent {
  return (MODEL_PROVIDER_AGENTS as readonly string[]).includes(agentType);
}

/** The agents a kind of provider can serve. */
export function modelProviderKindAgents(kind: ModelProviderKind): readonly ModelProviderAgent[] {
  return kind === "litellm" ? ["claude-code"] : MODEL_PROVIDER_AGENTS;
}

/**
 * How a pod signs in to the provider:
 * - `access-key`: stored AWS access key id + secret (+ optional session token)
 * - `bearer-token`: a stored Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`)
 * - `ambient`: the pod's own AWS identity (IRSA / instance profile on EKS)
 * - `api-key`: a stored LiteLLM key
 * - `none`: machines only — work in a pod can't use it
 */
export type ModelProviderPodCredential =
  "access-key" | "bearer-token" | "ambient" | "api-key" | "none";

export const MODEL_PROVIDER_POD_CREDENTIALS: readonly ModelProviderPodCredential[] = [
  "access-key",
  "bearer-token",
  "ambient",
  "api-key",
  "none",
];

/** The pod credentials each kind of provider accepts. */
export function modelProviderKindPodCredentials(
  kind: ModelProviderKind,
): readonly ModelProviderPodCredential[] {
  return kind === "litellm"
    ? ["api-key", "none"]
    : ["access-key", "bearer-token", "ambient", "none"];
}

/** Whether `credential` is one the server stores (encrypted) on the provider. */
export function isStoredPodCredential(credential: ModelProviderPodCredential): boolean {
  return credential === "access-key" || credential === "bearer-token" || credential === "api-key";
}

export interface ModelProviderModel {
  /** The provider's model id, passed to the CLI as-is. */
  id: string;
  /** Shown in pickers; the id when absent. */
  label?: string;
  /** Input tokens the model takes; absent = unknown (treated as 200k). */
  contextWindow?: number;
  /** Effort levels it accepts; absent = every level, empty = none. */
  efforts?: string[];
}

/** The models a provider offers each agent, in picker order; the first is the default. */
export interface ModelProviderModels {
  "claude-code"?: ModelProviderModel[];
  codex?: ModelProviderModel[];
}

/** Who a model provider, secret, connection or piece of work belongs to. */
export type ResourceOwner = "workspace" | "me";

export interface ModelProvider {
  id: string;
  workspaceId: string | null;
  /** Null = the organization's (every member can pick it). Set = one person's own. */
  ownerUserId: string | null;
  /** Display name of `ownerUserId`, for personal providers. */
  ownerName: string | null;
  kind: ModelProviderKind;
  name: string;
  agents: ModelProviderAgent[];
  /** AWS region the runtime calls (`us-west-2`); Bedrock only. */
  region: string | null;
  /** The proxy's URL (`http://litellm.ai:4000`); LiteLLM only. */
  baseUrl: string | null;
  /** The models offered for each agent, in picker order; the first is the default. */
  models: ModelProviderModels;
  /** AWS profile to use on a machine; null = the machine's default AWS credentials. */
  localAwsProfile: string | null;
  /** LiteLLM: the machine env var holding its key; null = the machine's own sign-in env. */
  localApiKeyEnv: string | null;
  podCredential: ModelProviderPodCredential;
  /** Whether stored pod credentials exist (the values are never returned). */
  hasPodCredentials: boolean;
  /** The viewer's own (personal) provider. */
  mine: boolean;
  /** Whether the viewer may change or delete it. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ModelProviderCredentials =
  | { type: "access-key"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { type: "bearer-token"; bearerToken: string }
  | { type: "api-key"; apiKey: string };

export interface CreateModelProviderInput {
  name: string;
  /** `workspace` needs an admin. */
  owner: ResourceOwner;
  kind: ModelProviderKind;
  agents: ModelProviderAgent[];
  /** Bedrock: required. */
  region?: string;
  /** LiteLLM: required. */
  baseUrl?: string;
  models?: ModelProviderModels;
  localAwsProfile?: string | null;
  localApiKeyEnv?: string | null;
  podCredential?: ModelProviderPodCredential;
  /** Replaces the stored pod credentials; null clears them; absent keeps them. */
  credentials?: ModelProviderCredentials | null;
}

/** A change to a model provider: absent fields are kept. */
export interface UpdateModelProviderInput {
  name?: string;
  /** Moving it to the organization needs an admin. */
  owner?: ResourceOwner;
  agents?: ModelProviderAgent[];
  region?: string;
  baseUrl?: string;
  models?: ModelProviderModels;
  localAwsProfile?: string | null;
  localApiKeyEnv?: string | null;
  podCredential?: ModelProviderPodCredential;
  /** Replaces the stored pod credentials; null clears them; absent keeps them. */
  credentials?: ModelProviderCredentials | null;
}

/**
 * What a spawn on a machine carries to use a provider: never a credential,
 * only where to call and where on the machine its credentials are.
 */
export interface ModelProviderLaunch {
  kind: ModelProviderKind;
  providerId: string;
  name: string;
  /** Bedrock. */
  region?: string;
  /** Bedrock: an AWS profile on the machine; absent = its default credentials. */
  awsProfile?: string;
  /** LiteLLM. */
  baseUrl?: string;
  /** LiteLLM: the machine env var holding its key; absent = the machine's own env. */
  apiKeyEnv?: string;
  /** LiteLLM: the picked model, for Claude Code's internal calls and context window. */
  model?: ModelProviderModel;
}

/** The agent-options key that selects a model provider for a run. */
export const MODEL_PROVIDER_OPTION_KEY = "modelProvider";

/** The provider a run's agent options pick, if any. */
export function modelProviderIdFrom(
  agentOptions: Record<string, unknown> | null | undefined,
): string | undefined {
  const v = agentOptions?.[MODEL_PROVIDER_OPTION_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const AWS_PROFILE_RE = /^[A-Za-z0-9._+=@-]{1,64}$/;

export function isValidAwsRegion(region: string): boolean {
  return AWS_REGION_RE.test(region);
}

export function isValidAwsProfileName(name: string): boolean {
  return AWS_PROFILE_RE.test(name);
}

const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

export function isValidEnvVarName(name: string): boolean {
  return ENV_VAR_RE.test(name);
}

/** An http(s) URL with no userinfo, query or fragment: a CLI appends its own paths. */
export function isValidProviderBaseUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !raw.includes("#") &&
    !raw.includes("?")
  );
}

export function normalizeProviderBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** The picked provider model, if `id` is one of the models it offers `agent`. */
export function findProviderModel(
  models: ModelProviderModels | null | undefined,
  agent: ModelProviderAgent,
  id: string | null | undefined,
): ModelProviderModel | undefined {
  return id ? models?.[agent]?.find((m) => m.id === id) : undefined;
}

/**
 * The Claude Code context window option for a provider model: `1m` adds a
 * `[1m]` suffix the proxy would treat as part of the model name, so only a
 * model known to take a million tokens gets it.
 */
export function providerModelContextWindow(model: ModelProviderModel): "200k" | "1m" {
  return (model.contextWindow ?? 0) >= 1_000_000 ? "1m" : "200k";
}

/**
 * The cross-region inference prefix Bedrock uses for Anthropic models in a
 * region (`us.anthropic.…` from us-west-2).
 */
export function bedrockInferencePrefix(region: string): string {
  if (region.startsWith("us-gov-")) return "us-gov";
  if (region.startsWith("us-") || region.startsWith("ca-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "global";
}

/** Suggested models for a new Bedrock provider (editable in Settings). */
export function bedrockDefaultModels(
  agent: ModelProviderAgent,
  region: string,
): ModelProviderModel[] {
  if (agent === "codex") {
    return [
      { id: "openai.gpt-5.5", label: "GPT-5.5" },
      { id: "openai.gpt-5.4", label: "GPT-5.4" },
    ];
  }
  const p = bedrockInferencePrefix(region);
  return [
    { id: `${p}.anthropic.claude-opus-5-5`, label: "Opus 5.5" },
    { id: `${p}.anthropic.claude-sonnet-5`, label: "Sonnet 5" },
    { id: `${p}.anthropic.claude-fable-5-1`, label: "Fable 5.1" },
    { id: `${p}.anthropic.claude-haiku-4-5-20251001-v1:0`, label: "Haiku 4.5" },
  ];
}

/**
 * The env and Codex config overrides that point an agent CLI at Bedrock.
 * One mapping for both run locations: the daemon calls it with the launch
 * (a machine AWS profile), the pod workers with the stored credentials.
 *
 * - Claude Code: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` (it doesn't read
 *   the region from ~/.aws/config).
 * - Codex: its built-in `amazon-bedrock` provider (`-c model_provider=…`),
 *   which reads `AWS_REGION` and the standard AWS credential chain.
 */
export function bedrockRuntime(
  agent: ModelProviderAgent,
  launch: { region: string; awsProfile?: string },
  credentials?: ModelProviderCredentials | null,
): { env: Record<string, string>; codexConfig: string[] } {
  const env: Record<string, string> = {
    AWS_REGION: launch.region,
    AWS_DEFAULT_REGION: launch.region,
  };
  if (launch.awsProfile) env.AWS_PROFILE = launch.awsProfile;
  if (credentials?.type === "access-key") {
    env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken;
  } else if (credentials?.type === "bearer-token") {
    env.AWS_BEARER_TOKEN_BEDROCK = credentials.bearerToken;
  }
  if (agent === "claude-code") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    return { env, codexConfig: [] };
  }
  return { env, codexConfig: ['model_provider="amazon-bedrock"'] };
}

/**
 * The env that points Claude Code at a LiteLLM proxy's Anthropic-compatible
 * endpoint. Claude Code makes its own background calls (titles, summaries,
 * subagents) with hardcoded Claude ids that a proxy key may not allow, so
 * every tier is pinned to the picked model.
 */
export function litellmRuntime(
  launch: Pick<ModelProviderLaunch, "baseUrl">,
  credentials?: ModelProviderCredentials | null,
  model?: ModelProviderModel,
): { env: Record<string, string>; codexConfig: string[] } {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: launch.baseUrl ?? "",
    // Proxied models reject Anthropic-only beta headers.
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
  };
  if (credentials?.type === "api-key") env.ANTHROPIC_AUTH_TOKEN = credentials.apiKey;
  if (model) {
    for (const name of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ])
      env[name] = model.id;
    if (model.contextWindow) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(model.contextWindow);
  }
  return { env, codexConfig: [] };
}

/** The env and Codex overrides for a provider of any kind. */
export function providerRuntime(
  agent: ModelProviderAgent,
  launch: Pick<ModelProviderLaunch, "kind" | "region" | "awsProfile" | "baseUrl" | "model">,
  credentials?: ModelProviderCredentials | null,
): { env: Record<string, string>; codexConfig: string[] } {
  if (launch.kind === "litellm") return litellmRuntime(launch, credentials, launch.model);
  return bedrockRuntime(
    agent,
    { region: launch.region ?? "", awsProfile: launch.awsProfile },
    credentials,
  );
}

/** Whether `role` may create or change organization-owned resources. */
export function canManageOrgResources(role: WorkspaceRole | null | undefined): boolean {
  return role === "admin";
}
