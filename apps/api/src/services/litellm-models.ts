import type { ModelProviderModel } from "@optio/shared";
import { SsrfError, guardedFetch, type OutboundOptions } from "../utils/outbound-url.js";

export class LitellmDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LitellmDiscoveryError";
  }
}

/** The outbound policy refused the URL: no other path on it would fare better. */
class LitellmBlockedError extends LitellmDiscoveryError {}

// What LiteLLM's /v1/messages adapter maps Claude Code's effort onto.
const REASONING_EFFORTS = ["low", "medium", "high"];

// LiteLLM model modes Claude Code can send messages to; a model without one is kept.
const CHAT_MODES = new Set(["chat", "completion", "responses"]);

interface ModelInfoEntry {
  model_name?: unknown;
  model_info?: { max_input_tokens?: unknown; supports_reasoning?: unknown; mode?: unknown } | null;
}

async function getJson(url: string, apiKey: string, opts: OutboundOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await guardedFetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      ...opts,
    });
  } catch (err) {
    if (err instanceof SsrfError) throw new LitellmBlockedError(`${url} ${err.message}`);
    throw new LitellmDiscoveryError(
      `Couldn't reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (response.status === 401) throw new LitellmDiscoveryError("LiteLLM refused the key");
  if (!response.ok) throw new LitellmDiscoveryError(`${url} answered ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new LitellmDiscoveryError(`${url} didn't answer with JSON`);
  }
}

function fromModelInfo(body: unknown): ModelProviderModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new LitellmDiscoveryError("/model/info returned no model list");
  const byId = new Map<string, ModelProviderModel>();
  for (const entry of data as ModelInfoEntry[]) {
    if (typeof entry?.model_name !== "string" || !entry.model_name) continue;
    // One model name can front several deployments; the first one describes it.
    if (byId.has(entry.model_name)) continue;
    const info = entry.model_info ?? {};
    if (typeof info.mode === "string" && !CHAT_MODES.has(info.mode)) continue;
    const model: ModelProviderModel = { id: entry.model_name };
    if (typeof info.max_input_tokens === "number" && info.max_input_tokens > 0) {
      model.contextWindow = Math.floor(info.max_input_tokens);
    }
    if (typeof info.supports_reasoning === "boolean") {
      model.efforts = info.supports_reasoning ? [...REASONING_EFFORTS] : [];
    }
    byId.set(model.id, model);
  }
  return [...byId.values()];
}

function fromOpenAiList(body: unknown): ModelProviderModel[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new LitellmDiscoveryError("/v1/models returned no model list");
  const ids = data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === "string" && !!id);
  return [...new Set(ids)].map((id) => ({ id }));
}

/**
 * The models a LiteLLM key can call. `/model/info` carries each model's
 * context window and reasoning support; a proxy that refuses it for the key
 * still answers the OpenAI-style `/v1/models`, with ids only.
 */
export async function discoverLitellmModels(
  baseUrl: string,
  apiKey: string,
  opts: OutboundOptions = {},
): Promise<ModelProviderModel[]> {
  let models: ModelProviderModel[];
  try {
    models = fromModelInfo(await getJson(`${baseUrl}/model/info`, apiKey, opts));
  } catch (err) {
    if (err instanceof LitellmBlockedError) throw err;
    models = fromOpenAiList(await getJson(`${baseUrl}/v1/models`, apiKey, opts));
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
