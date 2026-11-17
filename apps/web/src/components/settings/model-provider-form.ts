import {
  bedrockDefaultModels,
  isValidAwsProfileName,
  isValidAwsRegion,
  isStoredPodCredential,
  isValidLitellmKeyEnv,
  isValidProviderBaseUrl,
  MAX_PROVIDER_MODELS,
  modelProviderKindAgents,
  normalizeProviderBaseUrl,
  type CreateModelProviderInput,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderCredentials,
  type ModelProviderKind,
  type ModelProviderModel,
  type ModelProviderPodCredential,
  type ResourceOwner,
  type UpdateModelProviderInput,
} from "@optio/shared";

/**
 * The Settings → Model providers editor's state, and its round trip to the
 * API's create / update bodies. Credentials are write-only: an existing
 * provider shows "Stored" and keeps them unless you Replace or Clear.
 */

export const AGENT_LABELS: Record<ModelProviderAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export const POD_CREDENTIAL_LABELS: Record<ModelProviderPodCredential, string> = {
  "access-key": "Access key",
  "bearer-token": "API key",
  "api-key": "API key",
  ambient: "IAM role",
  none: "Machines only",
};

export const KIND_LABELS: Record<ModelProviderKind, string> = {
  bedrock: "Amazon Bedrock",
  litellm: "LiteLLM",
};

const DEFAULT_REGION = "us-west-2";

type CredentialAction = "keep" | "replace" | "clear";

export interface ProviderForm {
  kind: ModelProviderKind;
  name: string;
  owner: ResourceOwner;
  agents: ModelProviderAgent[];
  region: string;
  models: Partial<Record<ModelProviderAgent, ModelProviderModel[]>>;
  localAwsProfile: string;
  podCredential: ModelProviderPodCredential;
  credentialAction: CredentialAction;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bearerToken: string;
  baseUrl: string;
  localApiKeyEnv: string;
  apiKey: string;
}

const EMPTY_SECRETS = {
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  bearerToken: "",
  apiKey: "",
};

export function emptyProviderForm(
  isAdmin: boolean,
  kind: ModelProviderKind = "bedrock",
): ProviderForm {
  const owner = isAdmin ? "workspace" : "me";
  if (kind === "litellm") {
    return {
      kind,
      name: "LiteLLM",
      owner,
      agents: ["claude-code"],
      region: "",
      models: { "claude-code": [] },
      localAwsProfile: "",
      podCredential: "api-key",
      credentialAction: "replace",
      baseUrl: "",
      localApiKeyEnv: "LITELLM_API_KEY",
      ...EMPTY_SECRETS,
    };
  }
  return {
    kind,
    name: "Bedrock",
    owner: isAdmin ? "workspace" : "me",
    agents: ["claude-code"],
    region: DEFAULT_REGION,
    models: { "claude-code": bedrockDefaultModels("claude-code", DEFAULT_REGION) },
    localAwsProfile: "",
    podCredential: "access-key",
    credentialAction: "replace",
    baseUrl: "",
    localApiKeyEnv: "",
    ...EMPTY_SECRETS,
  };
}

export function formFromProvider(p: ModelProvider): ProviderForm {
  return {
    kind: p.kind,
    name: p.name,
    owner: p.ownerUserId ? "me" : "workspace",
    agents: [...p.agents],
    region: p.region ?? "",
    models: Object.fromEntries(
      Object.entries(p.models).map(([k, v]) => [
        k,
        ((v as ModelProviderModel[] | undefined) ?? []).map((m) => ({ ...m })),
      ]),
    ),
    localAwsProfile: p.localAwsProfile ?? "",
    podCredential: p.podCredential,
    credentialAction: p.hasPodCredentials ? "keep" : "replace",
    baseUrl: p.baseUrl ?? "",
    localApiKeyEnv: p.localApiKeyEnv ?? "",
    ...EMPTY_SECRETS,
  };
}

/** Check / uncheck an agent; a newly checked one starts from the suggested models. */
export function toggleAgent(f: ProviderForm, agent: ModelProviderAgent, on: boolean): ProviderForm {
  const agents = modelProviderKindAgents(f.kind).filter((a) =>
    a === agent ? on : f.agents.includes(a),
  );
  const models = { ...f.models };
  if (on && !models[agent]?.length) {
    models[agent] = f.kind === "bedrock" ? bedrockDefaultModels(agent, f.region) : [];
  }
  return { ...f, agents, models };
}

const sameModels = (a: ModelProviderModel[] | undefined, b: ModelProviderModel[]) =>
  !!a && a.length === b.length && a.every((m, i) => m.id === b[i].id);

/** Change the region; model lists still on the old region's suggestions follow it. */
export function withRegion(f: ProviderForm, region: string): ProviderForm {
  const models = { ...f.models };
  for (const agent of f.agents) {
    if (sameModels(models[agent], bedrockDefaultModels(agent, f.region))) {
      models[agent] = bedrockDefaultModels(agent, region);
    }
  }
  return { ...f, region, models };
}

/**
 * Parse the models textarea: one per line, `id` or `id | label`. A model
 * already in `previous` keeps its context window and efforts, which the
 * textarea doesn't show.
 */
export function parseModels(
  text: string,
  previous: ModelProviderModel[] = [],
): ModelProviderModel[] {
  const known = new Map<string, ModelProviderModel>();
  for (const m of previous) {
    if (!known.has(m.id) || m.contextWindow || m.efforts) known.set(m.id, m);
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("|");
      const label = rest.join("|").trim();
      const { contextWindow, efforts } = known.get(id.trim()) ?? {};
      return {
        id: id.trim(),
        ...(label ? { label } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(efforts ? { efforts } : {}),
      };
    })
    .filter((m) => m.id);
}

/** Refresh the picked models' context windows and efforts from what the proxy reported. */
export function withDiscoveredModels(
  f: ProviderForm,
  agent: ModelProviderAgent,
  discovered: ModelProviderModel[],
): ProviderForm {
  const byId = new Map(discovered.map((m) => [m.id, m]));
  const models = (f.models[agent] ?? []).map((m) => {
    const d = byId.get(m.id);
    return d ? { ...d, ...(m.label ? { label: m.label } : {}) } : m;
  });
  return { ...f, models: { ...f.models, [agent]: models } };
}

export interface ModelChoice {
  model: ModelProviderModel;
  picked: boolean;
  /** Whether the proxy lists it; null until the proxy was asked. */
  onProxy: boolean | null;
}

/** Picked models first, in their order (the first is the default), then the proxy's other models. */
export function modelChoices(
  picked: ModelProviderModel[],
  available: ModelProviderModel[],
  query: string,
): ModelChoice[] {
  const byId = new Map(available.map((m) => [m.id, m]));
  const pickedIds = new Set(picked.map((m) => m.id));
  const asked = available.length > 0;
  const choices: ModelChoice[] = [
    ...picked.map((m) => {
      const d = byId.get(m.id);
      return {
        model: d ? { ...d, ...(m.label ? { label: m.label } : {}) } : m,
        picked: true,
        onProxy: asked ? !!d : null,
      };
    }),
    ...available
      .filter((m) => !pickedIds.has(m.id))
      .map((m) => ({ model: m, picked: false, onProxy: true })),
  ];
  const q = query.trim().toLowerCase();
  return q ? choices.filter((c) => c.model.id.toLowerCase().includes(q)) : choices;
}

export function pickModels(
  picked: ModelProviderModel[],
  more: ModelProviderModel[],
): ModelProviderModel[] {
  const ids = new Set(picked.map((m) => m.id));
  const added: ModelProviderModel[] = [];
  for (const m of more) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    added.push(m);
  }
  return [...picked, ...added];
}

export function unpickModels(picked: ModelProviderModel[], ids: string[]): ModelProviderModel[] {
  const drop = new Set(ids);
  return picked.filter((m) => !drop.has(m.id));
}

export function makeDefaultModel(picked: ModelProviderModel[], id: string): ModelProviderModel[] {
  const m = picked.find((p) => p.id === id);
  return m ? [m, ...picked.filter((p) => p.id !== id)] : picked;
}

export function formatModels(models: ModelProviderModel[] | undefined): string {
  return (models ?? []).map((m) => (m.label ? `${m.id} | ${m.label}` : m.id)).join("\n");
}

/** What's wrong with the form, or null. */
export function validateProviderForm(f: ProviderForm, creating: boolean): string | null {
  if (!f.name.trim()) return "Give it a name.";
  if (f.agents.length === 0) return "Pick at least one agent.";
  const tooMany = f.agents.find((a) => (f.models[a]?.length ?? 0) > MAX_PROVIDER_MODELS);
  if (tooMany) return `Offer at most ${MAX_PROVIDER_MODELS} models per agent.`;
  if (f.kind === "litellm") {
    if (!isValidProviderBaseUrl(normalizeProviderBaseUrl(f.baseUrl))) {
      return "The URL looks like http://litellm:4000.";
    }
    if (f.localApiKeyEnv.trim() && !isValidLitellmKeyEnv(f.localApiKeyEnv.trim())) {
      return "The env var name has LITELLM in it, like LITELLM_API_KEY.";
    }
    if (f.podCredential === "api-key" && (creating || f.credentialAction === "replace")) {
      if (!f.apiKey.trim()) return "Enter the LiteLLM key, or make it machines only.";
    }
    if (f.agents.some((a) => !f.models[a]?.length)) return "Pick at least one model to offer.";
    return null;
  }
  if (!isValidAwsRegion(f.region.trim())) return "Region looks like us-west-2.";
  if (f.localAwsProfile.trim() && !isValidAwsProfileName(f.localAwsProfile.trim())) {
    return "That isn't a valid AWS profile name.";
  }
  const stores = isStoredPodCredential(f.podCredential);
  if (stores && (creating || f.credentialAction === "replace")) {
    if (f.podCredential === "access-key" && (!f.accessKeyId.trim() || !f.secretAccessKey.trim())) {
      return "Enter the access key id and secret, or pick another pod sign-in.";
    }
    if (f.podCredential === "bearer-token" && !f.bearerToken.trim()) {
      return "Enter the Bedrock API key, or pick another pod sign-in.";
    }
  }
  return null;
}

function credentialsFrom(f: ProviderForm): ModelProviderCredentials | null | undefined {
  if (!isStoredPodCredential(f.podCredential) || f.credentialAction === "clear") return null;
  if (f.credentialAction === "keep") return undefined;
  if (f.podCredential === "api-key") return { type: "api-key", apiKey: f.apiKey.trim() };
  if (f.podCredential === "access-key") {
    return {
      type: "access-key",
      accessKeyId: f.accessKeyId.trim(),
      secretAccessKey: f.secretAccessKey.trim(),
      ...(f.sessionToken.trim() ? { sessionToken: f.sessionToken.trim() } : {}),
    };
  }
  return { type: "bearer-token", bearerToken: f.bearerToken.trim() };
}

function modelsFor(f: ProviderForm): Partial<Record<ModelProviderAgent, ModelProviderModel[]>> {
  return Object.fromEntries(f.agents.map((a) => [a, f.models[a] ?? []]));
}

function kindFields(f: ProviderForm) {
  return f.kind === "litellm"
    ? {
        baseUrl: normalizeProviderBaseUrl(f.baseUrl),
        localApiKeyEnv: f.localApiKeyEnv.trim() || null,
      }
    : { region: f.region.trim(), localAwsProfile: f.localAwsProfile.trim() || null };
}

export function toCreateInput(f: ProviderForm): CreateModelProviderInput {
  const credentials = credentialsFrom(f);
  return {
    name: f.name.trim(),
    owner: f.owner,
    kind: f.kind,
    agents: f.agents,
    ...kindFields(f),
    models: modelsFor(f),
    podCredential: f.podCredential,
    ...(credentials ? { credentials } : {}),
  };
}

export function toUpdateInput(f: ProviderForm, original: ModelProvider): UpdateModelProviderInput {
  const credentials = credentialsFrom(f);
  // Nothing stored and nothing to store: leave the credentials alone.
  const sendCredentials =
    credentials !== undefined && !(credentials === null && !original.hasPodCredentials);
  return {
    name: f.name.trim(),
    ...(f.owner !== (original.ownerUserId ? "me" : "workspace") ? { owner: f.owner } : {}),
    agents: f.agents,
    ...kindFields(f),
    models: modelsFor(f),
    podCredential: f.podCredential,
    ...(sendCredentials ? { credentials } : {}),
  };
}

/** "Pods: access key" etc., for the list. */
export function podsLabel(p: Pick<ModelProvider, "podCredential">): string {
  return {
    "access-key": "Pods: access key",
    "bearer-token": "Pods: API key",
    "api-key": "Pods: API key",
    ambient: "Pods: IAM role",
    none: "Machines only",
  }[p.podCredential];
}
