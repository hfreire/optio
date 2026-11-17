import { describe, expect, it } from "vitest";
import {
  bedrockDefaultModels,
  bedrockInferencePrefix,
  bedrockRuntime,
  canManageOrgResources,
  isModelProviderAgent,
  isValidAwsProfileName,
  isValidAwsRegion,
  isValidEnvVarName,
  isValidProviderBaseUrl,
  litellmRuntime,
  modelProviderIdFrom,
  modelProviderKindAgents,
  normalizeProviderBaseUrl,
  providerModelContextWindow,
  providerRuntime,
} from "./model-provider.js";
import { secretCredentialId, secretIdFromCredential } from "./agent-credential.js";

describe("provider and credential input boundaries", () => {
  it("accepts only supported provider runtimes", () => {
    expect(isModelProviderAgent("claude-code")).toBe(true);
    expect(isModelProviderAgent("codex")).toBe(true);
    expect(isModelProviderAgent("terminal")).toBe(false);
  });
  it.each([
    undefined,
    null,
    {},
    { modelProvider: null },
    { modelProvider: 42 },
    { modelProvider: "  " },
  ])("ignores absent or malformed model provider selection %j", (options) => {
    expect(modelProviderIdFrom(options)).toBeUndefined();
  });
  it("trims an explicit provider id", () => {
    expect(modelProviderIdFrom({ modelProvider: " provider-id " })).toBe("provider-id");
  });
  it.each(["us-east-1", "us-gov-west-1", "ap-southeast-2"])("accepts region %s", (region) => {
    expect(isValidAwsRegion(region)).toBe(true);
  });
  it.each(["us-east-1;curl attacker", "$(id)", " US-east-1", "us-east"])(
    "rejects malformed region %s",
    (region) => {
      expect(isValidAwsRegion(region)).toBe(false);
    },
  );
  it("bounds profile names and rejects shell/config delimiters", () => {
    for (const name of ["production", "User+ops@example.com", "a".repeat(64)])
      expect(isValidAwsProfileName(name)).toBe(true);
    for (const name of [
      "",
      "a".repeat(65),
      "../prod",
      "prod\nrole_arn=other",
      "$(id)",
      "prod account",
    ])
      expect(isValidAwsProfileName(name)).toBe(false);
  });
  it.each(["member", "viewer", null, undefined] as const)(
    "does not grant organization administration to %s",
    (role) => {
      expect(canManageOrgResources(role)).toBe(false);
    },
  );
  it("grants organization administration to admins", () => {
    expect(canManageOrgResources("admin")).toBe(true);
  });
  it("recognizes only explicitly selected secret credentials", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(secretCredentialId(id)).toBe(`secret:${id}`);
    expect(secretIdFromCredential(`  secret:${id}  `)).toBe(id);
    for (const value of [
      null,
      undefined,
      {},
      3,
      id,
      `provider:${id}`,
      `secret:${id};curl attacker`,
      "secret:",
    ])
      expect(secretIdFromCredential(value)).toBeNull();
  });
});

describe("Bedrock runtime credentials", () => {
  it("ambient auth emits no stored credentials or profile", () => {
    expect(bedrockRuntime("claude-code", { region: "us-west-2" })).toEqual({
      env: {
        AWS_REGION: "us-west-2",
        AWS_DEFAULT_REGION: "us-west-2",
        CLAUDE_CODE_USE_BEDROCK: "1",
      },
      codexConfig: [],
    });
  });
  it("a local launch selects only its machine's profile", () => {
    expect(bedrockRuntime("codex", { region: "eu-west-1", awsProfile: "team" }, null)).toEqual({
      env: { AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1", AWS_PROFILE: "team" },
      codexConfig: ['model_provider="amazon-bedrock"'],
    });
  });
  it.each([undefined, "session-token"])(
    "includes an AWS session token only when supplied (%s)",
    (sessionToken) => {
      const runtime = bedrockRuntime(
        "codex",
        { region: "us-east-1" },
        { type: "access-key", accessKeyId: "access", secretAccessKey: "secret", sessionToken },
      );
      expect(runtime.env).toEqual({
        AWS_REGION: "us-east-1",
        AWS_DEFAULT_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "access",
        AWS_SECRET_ACCESS_KEY: "secret",
        ...(sessionToken ? { AWS_SESSION_TOKEN: sessionToken } : {}),
      });
    },
  );
  it("keeps bearer credentials separate from AWS access-key credentials", () => {
    expect(
      bedrockRuntime(
        "claude-code",
        { region: "us-west-2" },
        { type: "bearer-token", bearerToken: "bearer" },
      ).env,
    ).toEqual({
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
  });
  it.each([
    ["us-gov-west-1", "us-gov"],
    ["us-west-2", "us"],
    ["ca-central-1", "us"],
    ["eu-west-1", "eu"],
    ["ap-south-1", "apac"],
    ["sa-east-1", "global"],
  ])("maps %s to inference prefix %s", (region, prefix) => {
    expect(bedrockInferencePrefix(region)).toBe(prefix);
    expect(
      bedrockDefaultModels("claude-code", region).every((model) =>
        model.id.startsWith(`${prefix}.anthropic.`),
      ),
    ).toBe(true);
  });
  it("keeps OpenAI model ids independent of the inference region", () => {
    expect(bedrockDefaultModels("codex", "us-west-2")).toEqual(
      bedrockDefaultModels("codex", "eu-west-1"),
    );
    expect(
      bedrockDefaultModels("codex", "us-west-2").every((model) => model.id.startsWith("openai.")),
    ).toBe(true);
  });
});

describe("litellm model providers", () => {
  const launch = { baseUrl: "http://litellm.ai:4000" };
  const credentials = { type: "api-key", apiKey: "sk-optio" } as const;

  it("serves Claude Code only", () => {
    expect(modelProviderKindAgents("litellm")).toEqual(["claude-code"]);
    expect(modelProviderKindAgents("bedrock")).toEqual(["claude-code", "codex"]);
  });

  it("points Claude Code at the proxy with the stored key", () => {
    const { env, codexConfig } = litellmRuntime(launch, credentials);
    expect(env.ANTHROPIC_BASE_URL).toBe("http://litellm.ai:4000");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-optio");
    expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
    expect(codexConfig).toEqual([]);
  });

  it("sends Claude Code's internal model calls to the picked model", () => {
    const { env } = litellmRuntime(launch, credentials, {
      id: "local-coder",
      contextWindow: 262144,
    });
    for (const name of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ])
      expect(env[name]).toBe("local-coder");
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("262144");
  });

  it("leaves the key to the machine when none is stored", () => {
    expect(litellmRuntime(launch).env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("dispatches on the provider kind", () => {
    expect(
      providerRuntime("claude-code", { kind: "litellm", ...launch }, credentials).env
        .ANTHROPIC_BASE_URL,
    ).toBe("http://litellm.ai:4000");
    expect(
      providerRuntime("claude-code", { kind: "bedrock", region: "us-west-2" }).env
        .CLAUDE_CODE_USE_BEDROCK,
    ).toBe("1");
  });

  it.each(["http://litellm.ai:4000", "https://litellm.k8s1.se.home", "http://10.0.0.1:4000/"])(
    "accepts base URL %s",
    (url) => {
      expect(isValidProviderBaseUrl(url)).toBe(true);
    },
  );
  it.each([
    "",
    "litellm.ai:4000",
    "ftp://litellm",
    "http://user:pass@litellm",
    "http://litellm/?x=1",
    "http://litellm/#a",
    "javascript:alert(1)",
  ])("rejects base URL %s", (url) => {
    expect(isValidProviderBaseUrl(url)).toBe(false);
  });

  it("drops a trailing slash so the CLI appends its own paths cleanly", () => {
    expect(normalizeProviderBaseUrl(" http://litellm.ai:4000/ ")).toBe("http://litellm.ai:4000");
  });

  it.each(["LITELLM_API_KEY", "_KEY1"])("accepts env var name %s", (n) => {
    expect(isValidEnvVarName(n)).toBe(true);
  });
  it.each(["", "1KEY", "key", "A-B", "A B", "$(id)"])("rejects env var name %s", (n) => {
    expect(isValidEnvVarName(n)).toBe(false);
  });

  it("only narrows the context window for a 1M-capable model", () => {
    expect(providerModelContextWindow({ id: "a", contextWindow: 262144 })).toBe("200k");
    expect(providerModelContextWindow({ id: "a", contextWindow: 1_000_000 })).toBe("1m");
    expect(providerModelContextWindow({ id: "a" })).toBe("200k");
  });
});
