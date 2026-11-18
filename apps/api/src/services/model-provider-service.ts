import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  MODEL_PROVIDER_KINDS,
  MODEL_PROVIDER_POD_CREDENTIALS,
  findProviderModel,
  isModelProviderAgent,
  isStoredPodCredential,
  isValidAwsProfileName,
  isValidAwsRegion,
  isValidLitellmKeyEnv,
  isValidProviderBaseUrl,
  modelProviderIdFrom,
  modelProviderKindAgents,
  modelProviderKindPodCredentials,
  MODEL_PROVIDER_OPTION_KEY,
  normalizeProviderBaseUrl,
  providerModelContextWindow,
  providerRuntime,
  type CreateModelProviderInput,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderCredentials,
  type ModelProviderKind,
  type ModelProviderLaunch,
  type ModelProviderModel,
  type ModelProviderPodCredential,
  type UpdateModelProviderInput,
} from "@optio/shared";
import { db } from "../db/client.js";
import { modelProviders, users } from "../db/schema.js";
import { decrypt, encrypt } from "./secret-service.js";
import { LitellmDiscoveryError, discoverLitellmModels } from "./litellm-models.js";

/**
 * Model providers (Settings → Model providers): Amazon Bedrock for Claude
 * Code and Codex, or a LiteLLM proxy for Claude Code, owned by the organization (`owner_user_id` null) or by one
 * person. Work picks one through `agentOptions.modelProvider`; see
 * `@optio/shared` `types/model-provider.ts` for the model.
 *
 * Who may use one: the organization's, by any work in the workspace; a
 * personal one, only by work its owner owns (and on its owner's machines).
 * Pod credentials are encrypted on the row and never leave the server for a
 * machine — a machine uses its own AWS profile or env var.
 */

export type ModelProviderRow = typeof modelProviders.$inferSelect;

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

/** Who is asking: their workspace, id (null when auth is disabled) and whether they're an admin. */
export interface ProviderViewer {
  workspaceId: string | null;
  userId: string | null;
  isAdmin: boolean;
}

function credentialsAAD(id: string): Buffer {
  return Buffer.from(`model_provider|${id}`);
}

function sameWorkspace(a: string | null, b: string | null | undefined): boolean {
  return (a ?? null) === (b ?? null);
}

function toModelProvider(
  row: ModelProviderRow,
  viewer: ProviderViewer,
  ownerName: string | null = null,
): ModelProvider {
  const mine = !!row.ownerUserId && row.ownerUserId === viewer.userId;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    ownerName: row.ownerUserId ? ownerName : null,
    kind: row.kind,
    name: row.name,
    agents: row.agents.filter(isModelProviderAgent),
    region: row.region,
    baseUrl: row.baseUrl,
    models: row.models,
    localAwsProfile: row.localAwsProfile,
    localApiKeyEnv: row.localApiKeyEnv,
    podCredential: row.podCredential,
    hasPodCredentials: !!row.encryptedCredentials,
    mine,
    canEdit: row.ownerUserId ? mine : viewer.isAdmin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function ownerNames(rows: ModelProviderRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.ownerUserId).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const found = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, ids));
  return new Map(found.map((u) => [u.id, u.displayName || u.email]));
}

/**
 * The providers a viewer sees: the organization's and their own; an admin
 * also sees other members' personal ones (by name, read-only).
 */
export async function listModelProviders(viewer: ProviderViewer): Promise<ModelProvider[]> {
  const ws = viewer.workspaceId
    ? eq(modelProviders.workspaceId, viewer.workspaceId)
    : isNull(modelProviders.workspaceId);
  const visible = viewer.isAdmin
    ? undefined
    : viewer.userId
      ? or(isNull(modelProviders.ownerUserId), eq(modelProviders.ownerUserId, viewer.userId))
      : isNull(modelProviders.ownerUserId);
  const rows = await db
    .select()
    .from(modelProviders)
    .where(visible ? and(ws, visible) : ws)
    .orderBy(modelProviders.name);
  const names = await ownerNames(rows);
  return rows.map((r) => toModelProvider(r, viewer, names.get(r.ownerUserId ?? "") ?? null));
}

export async function getModelProviderRow(id: string): Promise<ModelProviderRow | null> {
  const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, id));
  return row ?? null;
}

// ── Validation ───────────────────────────────────────────────────────────────

function cleanModels(
  models: CreateModelProviderInput["models"] | undefined,
  agents: ModelProviderAgent[],
): Record<string, ModelProviderModel[]> {
  const out: Record<string, ModelProviderModel[]> = {};
  for (const agent of agents) {
    const list = models?.[agent] ?? [];
    const seen = new Set<string>();
    const cleaned: ModelProviderModel[] = [];
    for (const m of list) {
      const id = m.id?.trim();
      if (!id) continue;
      if (id.length > 200 || /\s/.test(id)) {
        throw new ModelProviderError(`Model id "${id}" isn't valid`);
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const label = m.label?.trim();
      const model: ModelProviderModel = label ? { id, label } : { id };
      if (m.contextWindow !== undefined) {
        if (!Number.isInteger(m.contextWindow) || m.contextWindow <= 0) {
          throw new ModelProviderError(`Model "${id}" has an invalid context window`);
        }
        model.contextWindow = m.contextWindow;
      }
      if (m.efforts !== undefined) {
        model.efforts = [...new Set(m.efforts.map((e) => e.trim()).filter(Boolean))];
      }
      cleaned.push(model);
    }
    out[agent] = cleaned;
  }
  return out;
}

function validateCredentials(
  kind: ModelProviderPodCredential,
  credentials: ModelProviderCredentials,
): void {
  if (credentials.type !== kind) {
    throw new ModelProviderError(
      `Pod credentials are a ${credentials.type} but the provider is set to ${kind}`,
    );
  }
  if (credentials.type === "access-key") {
    if (!credentials.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()) {
      throw new ModelProviderError("An AWS access key needs both the key id and the secret");
    }
  } else if (credentials.type === "bearer-token") {
    if (!credentials.bearerToken?.trim()) {
      throw new ModelProviderError("The Bedrock API key is empty");
    }
  } else if (!credentials.apiKey?.trim()) {
    throw new ModelProviderError("The LiteLLM key is empty");
  }
}

interface NormalizedFields {
  name?: string;
  agents?: ModelProviderAgent[];
  region?: string;
  baseUrl?: string;
  localAwsProfile?: string | null;
  localApiKeyEnv?: string | null;
  podCredential?: ModelProviderPodCredential;
}

function normalizeFields(
  kind: ModelProviderKind,
  input: UpdateModelProviderInput,
): NormalizedFields {
  const out: NormalizedFields = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new ModelProviderError("Give the provider a name");
    out.name = name;
  }
  if (input.agents !== undefined) {
    const served = modelProviderKindAgents(kind);
    const agents = [...new Set(input.agents)].filter((a) => served.includes(a));
    if (agents.length === 0) {
      throw new ModelProviderError(
        `Pick at least one agent (${served.join(", ")}) for the provider`,
      );
    }
    out.agents = agents;
  }
  if (input.region !== undefined && kind === "bedrock") {
    const region = input.region.trim();
    if (!isValidAwsRegion(region)) {
      throw new ModelProviderError(`"${region}" isn't an AWS region (like us-west-2)`);
    }
    out.region = region;
  }
  if (input.baseUrl !== undefined && kind === "litellm") {
    if (!isValidProviderBaseUrl(input.baseUrl)) {
      throw new ModelProviderError(
        `"${input.baseUrl}" isn't an http(s) URL (like http://litellm.ai:4000)`,
      );
    }
    out.baseUrl = normalizeProviderBaseUrl(input.baseUrl);
  }
  if (input.localApiKeyEnv !== undefined && kind === "litellm") {
    const name = input.localApiKeyEnv?.trim() || null;
    if (name && !isValidLitellmKeyEnv(name)) {
      throw new ModelProviderError(
        `"${name}" isn't an environment variable name with LITELLM in it (like LITELLM_API_KEY)`,
      );
    }
    out.localApiKeyEnv = name;
  }
  if (input.localAwsProfile !== undefined && kind === "bedrock") {
    const p = input.localAwsProfile?.trim() || null;
    if (p && !isValidAwsProfileName(p)) {
      throw new ModelProviderError(`"${p}" isn't an AWS profile name`);
    }
    out.localAwsProfile = p;
  }
  if (input.podCredential !== undefined) {
    if (!MODEL_PROVIDER_POD_CREDENTIALS.includes(input.podCredential)) {
      throw new ModelProviderError(`Unknown pod credential "${input.podCredential}"`);
    }
    if (!modelProviderKindPodCredentials(kind).includes(input.podCredential)) {
      throw new ModelProviderError(
        `A ${kind} provider can't sign pods in with ${input.podCredential}`,
      );
    }
    out.podCredential = input.podCredential;
  }
  return out;
}

function sealCredentials(id: string, credentials: ModelProviderCredentials) {
  const blob = encrypt(JSON.stringify(credentials), credentialsAAD(id));
  return {
    encryptedCredentials: blob.ciphertext,
    credentialsIv: blob.iv,
    credentialsAuthTag: blob.authTag,
  };
}

function openCredentials(row: ModelProviderRow): ModelProviderCredentials | null {
  if (!row.encryptedCredentials || !row.credentialsIv || !row.credentialsAuthTag) return null;
  const json = decrypt(
    {
      alg: 1,
      iv: row.credentialsIv,
      ciphertext: row.encryptedCredentials,
      authTag: row.credentialsAuthTag,
    },
    credentialsAAD(row.id),
    `model provider ${row.name}`,
  );
  return JSON.parse(json) as ModelProviderCredentials;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

function assertCanEdit(row: ModelProviderRow, viewer: ProviderViewer): void {
  if (!sameWorkspace(row.workspaceId, viewer.workspaceId)) {
    throw new ModelProviderError("Model provider not found", 404);
  }
  if (row.ownerUserId) {
    if (row.ownerUserId !== viewer.userId) {
      throw new ModelProviderError("Only its owner can change a personal model provider", 403);
    }
  } else if (!viewer.isAdmin) {
    throw new ModelProviderError("Only admins can change the organization's model providers", 403);
  }
}

export async function createModelProvider(
  input: CreateModelProviderInput,
  viewer: ProviderViewer,
): Promise<ModelProvider> {
  if (!MODEL_PROVIDER_KINDS.includes(input.kind)) {
    throw new ModelProviderError(`Unknown provider "${input.kind}"`);
  }
  const kind = input.kind;
  // Auth-disabled dev has no user to own a personal provider: it's the org's.
  const ownerUserId = input.owner === "me" && viewer.userId ? viewer.userId : null;
  if (!ownerUserId && !viewer.isAdmin) {
    throw new ModelProviderError("Only admins can add a model provider for the organization", 403);
  }
  const fields = normalizeFields(kind, {
    ...input,
    agents: input.agents ?? [],
    region: input.region ?? "",
    baseUrl: input.baseUrl ?? "",
  });
  const agents = fields.agents!;
  const podCredential = fields.podCredential ?? "none";
  if (input.credentials) validateCredentials(podCredential, input.credentials);
  if (isStoredPodCredential(podCredential) && !input.credentials) {
    throw new ModelProviderError(
      "Add the pod credentials, or pick another way for pods to sign in",
    );
  }
  const [row] = await db
    .insert(modelProviders)
    .values({
      workspaceId: viewer.workspaceId,
      ownerUserId,
      createdBy: viewer.userId,
      kind,
      name: fields.name!,
      agents,
      region: fields.region ?? null,
      baseUrl: fields.baseUrl ?? null,
      models: cleanModels(input.models, agents),
      localAwsProfile: fields.localAwsProfile ?? null,
      localApiKeyEnv: fields.localApiKeyEnv ?? null,
      podCredential,
    })
    .returning();
  let saved = row;
  if (input.credentials && isStoredPodCredential(podCredential)) {
    [saved] = await db
      .update(modelProviders)
      .set(sealCredentials(row.id, input.credentials))
      .where(eq(modelProviders.id, row.id))
      .returning();
  }
  const names = await ownerNames([saved]);
  return toModelProvider(saved, viewer, names.get(saved.ownerUserId ?? "") ?? null);
}

export async function updateModelProvider(
  id: string,
  input: UpdateModelProviderInput,
  viewer: ProviderViewer,
): Promise<ModelProvider> {
  const row = await getModelProviderRow(id);
  if (!row) throw new ModelProviderError("Model provider not found", 404);
  assertCanEdit(row, viewer);
  const fields = normalizeFields(row.kind, input);
  const updates: Partial<typeof modelProviders.$inferInsert> = { updatedAt: new Date() };
  if (fields.name !== undefined) updates.name = fields.name;
  if (fields.region !== undefined) updates.region = fields.region;
  if (fields.baseUrl !== undefined) updates.baseUrl = fields.baseUrl;
  if (fields.localAwsProfile !== undefined) updates.localAwsProfile = fields.localAwsProfile;
  if (fields.localApiKeyEnv !== undefined) updates.localApiKeyEnv = fields.localApiKeyEnv;
  const agents = fields.agents ?? row.agents.filter(isModelProviderAgent);
  if (fields.agents !== undefined) updates.agents = agents;
  if (input.models !== undefined || fields.agents !== undefined) {
    updates.models = cleanModels(input.models ?? row.models, agents);
  }
  if (input.owner !== undefined) {
    // Moving it to the org needs an admin; making it personal makes it the editor's.
    if (input.owner === "workspace" && row.ownerUserId) {
      if (!viewer.isAdmin) {
        throw new ModelProviderError(
          "Only admins can give a model provider to the organization",
          403,
        );
      }
      updates.ownerUserId = null;
    } else if (input.owner === "me" && !row.ownerUserId && viewer.userId) {
      updates.ownerUserId = viewer.userId;
    }
  }
  const podCredential = fields.podCredential ?? row.podCredential;
  if (fields.podCredential !== undefined) updates.podCredential = podCredential;
  if (input.credentials === null || !isStoredPodCredential(podCredential)) {
    updates.encryptedCredentials = null;
    updates.credentialsIv = null;
    updates.credentialsAuthTag = null;
  } else if (input.credentials) {
    validateCredentials(podCredential, input.credentials);
    Object.assign(updates, sealCredentials(row.id, input.credentials));
  } else if (fields.podCredential !== undefined && fields.podCredential !== row.podCredential) {
    throw new ModelProviderError("Add the pod credentials for the new sign-in method");
  } else if (
    fields.baseUrl !== undefined &&
    fields.baseUrl !== row.baseUrl &&
    row.encryptedCredentials
  ) {
    // The stored key only ever goes where it was entered for.
    throw new ModelProviderError("Enter the key again for the new URL");
  }
  const [saved] = await db
    .update(modelProviders)
    .set(updates)
    .where(eq(modelProviders.id, id))
    .returning();
  const names = await ownerNames([saved]);
  return toModelProvider(saved, viewer, names.get(saved.ownerUserId ?? "") ?? null);
}

export async function deleteModelProvider(id: string, viewer: ProviderViewer): Promise<void> {
  const row = await getModelProviderRow(id);
  if (!row) throw new ModelProviderError("Model provider not found", 404);
  // Admins may remove anyone's (e.g. a departed member's); owners their own.
  if (!(viewer.isAdmin && sameWorkspace(row.workspaceId, viewer.workspaceId))) {
    assertCanEdit(row, viewer);
  }
  await db.delete(modelProviders).where(eq(modelProviders.id, id));
}

export interface DiscoverModelsInput {
  kind: "litellm";
  baseUrl: string;
  apiKey?: string;
  /** A saved provider whose stored key to use when no key is given. */
  providerId?: string;
}

/** The models a LiteLLM proxy offers the key, for the Settings form to fill in. */
export async function discoverProviderModels(
  input: DiscoverModelsInput,
  viewer: ProviderViewer,
): Promise<ModelProviderModel[]> {
  if (!isValidProviderBaseUrl(input.baseUrl)) {
    throw new ModelProviderError(`"${input.baseUrl}" isn't an http(s) URL`);
  }
  let apiKey = input.apiKey?.trim();
  if (!apiKey && input.providerId) {
    const row = await getModelProviderRow(input.providerId);
    if (!row) throw new ModelProviderError("Model provider not found", 404);
    assertCanEdit(row, viewer);
    // The stored key only ever goes where the provider already sends it.
    if (row.baseUrl !== normalizeProviderBaseUrl(input.baseUrl)) {
      throw new ModelProviderError("Enter the key again to list the models at a new URL");
    }
    const stored = openCredentials(row);
    apiKey = stored?.type === "api-key" ? stored.apiKey : undefined;
  }
  if (!apiKey) throw new ModelProviderError("Add the LiteLLM key to list its models");
  try {
    return await discoverLitellmModels(normalizeProviderBaseUrl(input.baseUrl), apiKey);
  } catch (err) {
    if (err instanceof LitellmDiscoveryError) throw new ModelProviderError(err.message);
    throw err;
  }
}

// ── Use by work ──────────────────────────────────────────────────────────────

export interface ProviderUse {
  agentType: string;
  agentOptions: Record<string, unknown> | null | undefined;
  workspaceId: string | null | undefined;
  /** The work's owner (null = the organization). */
  ownerUserId: string | null | undefined;
  runsOn: "pod" | "local";
}

/**
 * The provider a piece of work picks, checked against who may use it:
 * null when it picks none. Throws a `ModelProviderError` saying why not
 * (gone, another workspace's, someone else's, doesn't serve the agent,
 * machines only).
 */
export async function resolveProviderForWork(use: ProviderUse): Promise<ModelProviderRow | null> {
  const id = modelProviderIdFrom(use.agentOptions);
  if (!id) return null;
  const row = /^[0-9a-f-]{36}$/i.test(id) ? await getModelProviderRow(id) : null;
  if (!row || !sameWorkspace(row.workspaceId, use.workspaceId)) {
    throw new ModelProviderError("The model provider this work uses was removed — pick another");
  }
  if (row.ownerUserId && row.ownerUserId !== (use.ownerUserId ?? null)) {
    throw new ModelProviderError(
      `"${row.name}" is someone's own model provider — only work they own can use it`,
    );
  }
  if (!isModelProviderAgent(use.agentType) || !row.agents.includes(use.agentType)) {
    throw new ModelProviderError(`"${row.name}" isn't set up for ${use.agentType}`);
  }
  if (use.runsOn === "pod" && row.podCredential === "none") {
    throw new ModelProviderError(`"${row.name}" is set up for machines only, not pods`);
  }
  if (
    use.runsOn === "pod" &&
    isStoredPodCredential(row.podCredential) &&
    !row.encryptedCredentials
  ) {
    throw new ModelProviderError(`"${row.name}" has no pod credentials stored`);
  }
  return row;
}

/** A provider pick that is valid for the work, as a 400-able error message (or null). */
export async function providerSelectionError(use: ProviderUse): Promise<string | null> {
  try {
    await resolveProviderForWork(use);
    return null;
  } catch (err) {
    if (err instanceof ModelProviderError) return err.message;
    throw err;
  }
}

/** Why a repo can't default Claude Code to the provider (null if it can): the organization's, for pods. */
export async function repoModelProviderError(
  providerId: string,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  return providerSelectionError({
    agentType: "claude-code",
    agentOptions: { [MODEL_PROVIDER_OPTION_KEY]: providerId },
    workspaceId,
    ownerUserId: null,
    runsOn: "pod",
  });
}

function pickedModel(
  row: ModelProviderRow,
  agentType: ModelProviderAgent,
  modelId: string | null | undefined,
): ModelProviderModel | undefined {
  return (
    findProviderModel(row.models, agentType, modelId) ?? (modelId ? { id: modelId } : undefined)
  );
}

/**
 * What a spawn on a machine carries: where to call, which AWS profile or env
 * var holds the machine's own key — no credentials.
 */
export function providerLaunch(
  row: ModelProviderRow,
  agentType?: string,
  modelId?: string | null,
): ModelProviderLaunch {
  const base = { kind: row.kind, providerId: row.id, name: row.name };
  if (row.kind === "litellm") {
    const model =
      agentType && isModelProviderAgent(agentType)
        ? pickedModel(row, agentType, modelId)
        : undefined;
    return {
      ...base,
      baseUrl: row.baseUrl ?? "",
      ...(row.localApiKeyEnv ? { apiKeyEnv: row.localApiKeyEnv } : {}),
      ...(model ? { model } : {}),
    };
  }
  return {
    ...base,
    region: row.region ?? "",
    ...(row.localAwsProfile ? { awsProfile: row.localAwsProfile } : {}),
  };
}

export interface PodProviderRuntime {
  env: Record<string, string>;
  codexConfig: string[];
  /** The auth mode the agent adapter runs in. */
  authMode: ModelProviderKind;
  /** Overrides the work's Claude context window: a proxy model only gets `[1m]` when it takes 1M. */
  claudeContextWindow?: "200k" | "1m";
  /** The efforts the picked proxy model takes, when the proxy said. */
  claudeEfforts?: string[];
}

/** The work's Claude effort, unless the picked provider model doesn't take it. */
export function providerClaudeEffort(
  runtime: PodProviderRuntime | null | undefined,
  effort: string | undefined,
): string | undefined {
  if (!effort || !runtime?.claudeEfforts) return effort;
  return runtime.claudeEfforts.includes(effort) ? effort : undefined;
}

/** The env + Codex overrides a pod run gets for the provider, credentials included. */
export function podProviderRuntime(
  row: ModelProviderRow,
  agentType: string,
  modelId?: string | null,
): PodProviderRuntime {
  if (!isModelProviderAgent(agentType)) return { env: {}, codexConfig: [], authMode: row.kind };
  const credentials = isStoredPodCredential(row.podCredential) ? openCredentials(row) : null;
  const launch = providerLaunch(row, agentType, modelId);
  const runtime = providerRuntime(agentType, launch, credentials);
  if (row.kind !== "litellm") return { ...runtime, authMode: row.kind };
  return {
    ...runtime,
    authMode: row.kind,
    claudeContextWindow: providerModelContextWindow(launch.model ?? { id: "" }),
    ...(launch.model?.efforts ? { claudeEfforts: launch.model.efforts } : {}),
  };
}
