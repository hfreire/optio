import { describe, expect, it, vi } from "vitest";
import { discoverLitellmModels, LitellmDiscoveryError } from "./litellm-models.js";

const resolveHost = async () => [{ address: "93.184.216.34", family: 4 as const }];

function fetchReturning(routes: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (url: string, _init: RequestInit) => {
    const hit = routes[new URL(url).pathname];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit.body), { status: hit.status });
  });
}

describe("discoverLitellmModels", () => {
  it("reads context windows and reasoning support from /model/info", async () => {
    const fetchImpl = fetchReturning({
      "/model/info": {
        status: 200,
        body: {
          data: [
            {
              model_name: "local-coder",
              model_info: { max_input_tokens: 262144, supports_reasoning: true },
            },
            { model_name: "local-coder", model_info: { max_input_tokens: 262144 } },
            {
              model_name: "gpt-4o-mini",
              model_info: { max_input_tokens: 128000, supports_reasoning: false },
            },
            { model_name: "mystery", model_info: {} },
          ],
        },
      },
    });
    const models = await discoverLitellmModels("http://litellm.example:4000", "sk-1", {
      fetchImpl,
      resolveHost,
    });
    expect(models).toEqual([
      { id: "gpt-4o-mini", contextWindow: 128000, efforts: [] },
      { id: "local-coder", contextWindow: 262144, efforts: ["low", "medium", "high"] },
      { id: "mystery" },
    ]);
    const [, init] = fetchImpl.mock.calls[0];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-1");
  });

  it("falls back to the OpenAI model list when /model/info is refused", async () => {
    const fetchImpl = fetchReturning({
      "/model/info": { status: 403, body: { error: "admin only" } },
      "/v1/models": { status: 200, body: { data: [{ id: "b" }, { id: "a" }] } },
    });
    const models = await discoverLitellmModels("http://litellm.example:4000", "sk-1", {
      fetchImpl,
      resolveHost,
    });
    expect(models).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("says the key was refused on a 401", async () => {
    const fetchImpl = fetchReturning({
      "/model/info": { status: 401, body: {} },
      "/v1/models": { status: 401, body: {} },
    });
    await expect(
      discoverLitellmModels("http://litellm.example:4000", "bad", { fetchImpl, resolveHost }),
    ).rejects.toThrow(/refused the key/);
  });

  it("reports a proxy that doesn't answer JSON as a discovery error", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(
      discoverLitellmModels("http://litellm.example:4000", "sk-1", { fetchImpl, resolveHost }),
    ).rejects.toThrow(LitellmDiscoveryError);
  });

  it("refuses private addresses the outbound policy doesn't allow", async () => {
    const fetchImpl = fetchReturning({});
    await expect(
      discoverLitellmModels("http://litellm.ai:4000", "sk-1", {
        fetchImpl,
        resolveHost: async () => [{ address: "10.43.0.10", family: 4 as const }],
        policy: { allowPrivate: false, allowedHosts: [], allowAll: false },
      }),
    ).rejects.toBeInstanceOf(LitellmDiscoveryError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
