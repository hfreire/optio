import { describe, expect, it } from "vitest";
import type { ModelProvider } from "@optio/shared";
import {
  emptyProviderForm,
  formFromProvider,
  formatModels,
  makeDefaultModel,
  modelChoices,
  parseModels,
  pickModels,
  podsLabel,
  toCreateInput,
  toUpdateInput,
  toggleAgent,
  unpickModels,
  validateProviderForm,
  withDiscoveredModels,
  withRegion,
} from "./model-provider-form";

const saved: ModelProvider = {
  id: "p1",
  workspaceId: "ws",
  ownerUserId: null,
  ownerName: null,
  kind: "bedrock",
  name: "Bedrock",
  agents: ["claude-code"],
  region: "us-west-2",
  models: { "claude-code": [{ id: "us.anthropic.claude-opus-5-5", label: "Opus 5.5" }] },
  localAwsProfile: null,
  baseUrl: null,
  localApiKeyEnv: null,
  podCredential: "access-key",
  hasPodCredentials: true,
  mine: false,
  canEdit: true,
  createdAt: "",
  updatedAt: "",
};

describe("model provider form", () => {
  it("starts with Claude Code, us-west-2, and its suggested models; owner by role", () => {
    const f = emptyProviderForm(true);
    expect(f.owner).toBe("workspace");
    expect(emptyProviderForm(false).owner).toBe("me");
    expect(f.models["claude-code"]?.[0].id).toBe("us.anthropic.claude-opus-5-5");
  });

  it("prefills a newly checked agent and moves untouched suggestions with the region", () => {
    const f = toggleAgent(emptyProviderForm(true), "codex", true);
    expect(f.agents).toEqual(["claude-code", "codex"]);
    expect(f.models.codex?.[0].id).toBe("openai.gpt-5.5");
    const eu = withRegion(f, "eu-west-1");
    expect(eu.models["claude-code"]?.[0].id).toBe("eu.anthropic.claude-opus-5-5");
    // Edited lists stay put.
    const edited = { ...f, models: { ...f.models, "claude-code": [{ id: "custom" }] } };
    expect(withRegion(edited, "eu-west-1").models["claude-code"]).toEqual([{ id: "custom" }]);
  });

  it("parses and formats model lines", () => {
    const models = parseModels("a.b | A\n\n  c.d  \n");
    expect(models).toEqual([{ id: "a.b", label: "A" }, { id: "c.d" }]);
    expect(formatModels(models)).toBe("a.b | A\nc.d");
  });

  it("validates", () => {
    const f = emptyProviderForm(true);
    expect(validateProviderForm(f, true)).toMatch(/access key/);
    const ok = { ...f, accessKeyId: "AKIA", secretAccessKey: "s" };
    expect(validateProviderForm(ok, true)).toBeNull();
    expect(validateProviderForm({ ...ok, region: "west" }, true)).toMatch(/Region/);
    expect(validateProviderForm({ ...ok, agents: [] }, true)).toMatch(/agent/);
    expect(validateProviderForm({ ...f, podCredential: "ambient" }, true)).toBeNull();
    // Editing with stored credentials kept needs nothing typed.
    expect(validateProviderForm(formFromProvider(saved), false)).toBeNull();
  });

  it("builds the create body with credentials only when stored ones are wanted", () => {
    const body = toCreateInput({
      ...emptyProviderForm(true),
      accessKeyId: " AKIA ",
      secretAccessKey: "s",
    });
    expect(body).toMatchObject({
      kind: "bedrock",
      owner: "workspace",
      region: "us-west-2",
      localAwsProfile: null,
      credentials: { type: "access-key", accessKeyId: "AKIA", secretAccessKey: "s" },
    });
    expect(
      toCreateInput({ ...emptyProviderForm(true), podCredential: "ambient" }),
    ).not.toHaveProperty("credentials");
  });

  it("update keeps, replaces, or clears the stored credentials", () => {
    const f = formFromProvider(saved);
    expect(toUpdateInput(f, saved)).not.toHaveProperty("credentials");
    expect(toUpdateInput(f, saved)).not.toHaveProperty("owner");
    expect(toUpdateInput({ ...f, credentialAction: "clear" }, saved).credentials).toBeNull();
    expect(
      toUpdateInput(
        { ...f, credentialAction: "replace", podCredential: "bearer-token", bearerToken: "t" },
        saved,
      ).credentials,
    ).toEqual({ type: "bearer-token", bearerToken: "t" });
    // Switching to the pod's IAM role drops what was stored.
    expect(toUpdateInput({ ...f, podCredential: "ambient" }, saved).credentials).toBeNull();
    expect(toUpdateInput({ ...f, owner: "me" }, saved).owner).toBe("me");
  });

  it("labels pod sign-in for the list", () => {
    expect(podsLabel({ podCredential: "bearer-token" })).toBe("Pods: API key");
    expect(podsLabel({ podCredential: "none" })).toBe("Machines only");
  });
});

describe("LiteLLM provider form", () => {
  const litellmSaved: ModelProvider = {
    ...saved,
    kind: "litellm",
    name: "Home LiteLLM",
    region: null,
    baseUrl: "http://litellm.ai:4000",
    localApiKeyEnv: "LITELLM_API_KEY",
    podCredential: "api-key",
    models: { "claude-code": [{ id: "local-coder", contextWindow: 262144, efforts: ["low"] }] },
  };

  it("starts as a Claude Code proxy with an API key for pods", () => {
    const f = emptyProviderForm(true, "litellm");
    expect(f).toMatchObject({
      kind: "litellm",
      name: "LiteLLM",
      agents: ["claude-code"],
      podCredential: "api-key",
      localApiKeyEnv: "LITELLM_API_KEY",
      models: { "claude-code": [] },
    });
  });

  it("needs a URL, a key for pods, and a valid env var name", () => {
    const f = emptyProviderForm(true, "litellm");
    expect(validateProviderForm(f, true)).toMatch(/URL/);
    const withUrl = { ...f, baseUrl: "http://litellm.ai:4000" };
    expect(validateProviderForm(withUrl, true)).toMatch(/LiteLLM key/);
    const withKey = { ...withUrl, apiKey: "sk-1" };
    expect(validateProviderForm(withKey, true)).toMatch(/at least one model/);
    const picked = { ...withKey, models: { "claude-code": [{ id: "local-coder" }] } };
    expect(validateProviderForm(picked, true)).toBeNull();
    expect(validateProviderForm({ ...picked, localApiKeyEnv: "not ok" }, true)).toMatch(/env var/);
    expect(validateProviderForm({ ...picked, baseUrl: "litellm:4000" }, true)).toMatch(/URL/);
  });

  it("sends the URL, the key and the env var, no region", () => {
    const f = {
      ...emptyProviderForm(true, "litellm"),
      baseUrl: " http://litellm.ai:4000/ ",
      apiKey: " sk-1 ",
    };
    const input = toCreateInput(f);
    expect(input).toMatchObject({
      kind: "litellm",
      agents: ["claude-code"],
      baseUrl: "http://litellm.ai:4000",
      localApiKeyEnv: "LITELLM_API_KEY",
      podCredential: "api-key",
      credentials: { type: "api-key", apiKey: "sk-1" },
    });
    expect(input).not.toHaveProperty("region");
    expect(input).not.toHaveProperty("localAwsProfile");
  });

  it("keeps a saved model's context window and efforts through the textarea", () => {
    const f = formFromProvider(litellmSaved);
    expect(f.baseUrl).toBe("http://litellm.ai:4000");
    const text = formatModels(f.models["claude-code"]);
    expect(parseModels(`${text}\nnew-one`, f.models["claude-code"])).toEqual([
      { id: "local-coder", contextWindow: 262144, efforts: ["low"] },
      { id: "new-one" },
    ]);
  });

  it("labels its pods credential", () => {
    expect(podsLabel(litellmSaved)).toBe("Pods: API key");
    expect(toUpdateInput(formFromProvider(litellmSaved), litellmSaved)).not.toHaveProperty(
      "credentials",
    );
  });
});

describe("LiteLLM model picker", () => {
  const proxy = [
    { id: "gpt-5", contextWindow: 272000, efforts: ["low", "medium", "high"] },
    { id: "local-coder", contextWindow: 262144, efforts: [] },
    { id: "qwen3.8-max", contextWindow: 131072 },
  ];

  it("lists the picked models first, in order, then the rest of the proxy's", () => {
    const picked = [{ id: "local-coder" }, { id: "gone-model" }];
    expect(modelChoices(picked, proxy, "")).toEqual([
      {
        model: { id: "local-coder", contextWindow: 262144, efforts: [] },
        picked: true,
        onProxy: true,
      },
      { model: { id: "gone-model" }, picked: true, onProxy: false },
      { model: proxy[0], picked: false, onProxy: true },
      { model: proxy[2], picked: false, onProxy: true },
    ]);
  });

  it("doesn't flag picked models before the proxy was asked", () => {
    expect(modelChoices([{ id: "local-coder" }], [], "")).toEqual([
      { model: { id: "local-coder" }, picked: true, onProxy: null },
    ]);
  });

  it("filters by a case-insensitive part of the id", () => {
    expect(modelChoices([{ id: "local-coder" }], proxy, "QWEN").map((c) => c.model.id)).toEqual([
      "qwen3.8-max",
    ]);
  });

  it("appends picks, drops unpicks, and moves one to the front as the default", () => {
    const picked = pickModels([{ id: "a" }], [{ id: "b" }, { id: "a" }, { id: "c" }]);
    expect(picked.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(unpickModels(picked, ["b"]).map((m) => m.id)).toEqual(["a", "c"]);
    expect(makeDefaultModel(picked, "c").map((m) => m.id)).toEqual(["c", "a", "b"]);
  });

  it("refuses more models than the API stores", () => {
    const f = {
      ...emptyProviderForm(true, "litellm"),
      baseUrl: "http://litellm.ai:4000",
      apiKey: "sk-1",
      models: { "claude-code": Array.from({ length: 51 }, (_, i) => ({ id: `m${i}` })) },
    };
    expect(validateProviderForm(f, true)).toMatch(/at most 50/);
    expect(
      validateProviderForm(
        { ...f, models: { "claude-code": f.models["claude-code"].slice(1) } },
        true,
      ),
    ).toBeNull();
  });

  it("refreshes the picked models' limits from a fetch without picking new ones", () => {
    const f = {
      ...emptyProviderForm(true, "litellm"),
      models: { "claude-code": [{ id: "local-coder", label: "Coder" }] },
    };
    expect(withDiscoveredModels(f, "claude-code", proxy).models["claude-code"]).toEqual([
      { id: "local-coder", label: "Coder", contextWindow: 262144, efforts: [] },
    ]);
  });
});
