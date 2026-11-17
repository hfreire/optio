import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildAgentCommand } from "../local/agent-command.js";
import { listAwsProfiles } from "../local/aws-profiles.js";

const SETTINGS = "/home/u/.config/optio/local/claude-hooks.json";
const CLAUDE = `claude --settings '${SETTINGS}' --dangerously-skip-permissions`;

describe("buildAgentCommand with a model provider", () => {
  it("runs Claude Code on Bedrock with the machine's AWS profile, dropping exported keys", () => {
    expect(
      buildAgentCommand("claude-code", "hi", SETTINGS, {
        model: "us.anthropic.claude-opus-5-5",
        provider: { kind: "bedrock", region: "us-west-2", awsProfile: "bedrock" },
      }),
    ).toBe(
      "env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_BEARER_TOKEN_BEDROCK " +
        "AWS_REGION='us-west-2' AWS_DEFAULT_REGION='us-west-2' AWS_PROFILE='bedrock' CLAUDE_CODE_USE_BEDROCK='1' " +
        `${CLAUDE} --model 'us.anthropic.claude-opus-5-5' 'hi'`,
    );
  });

  it("uses the default AWS credentials when no profile is named", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { kind: "bedrock", region: "eu-west-1" },
    });
    expect(cmd).toBe(
      `env AWS_REGION='eu-west-1' AWS_DEFAULT_REGION='eu-west-1' CLAUDE_CODE_USE_BEDROCK='1' ${CLAUDE}`,
    );
  });

  it("points Codex at its amazon-bedrock provider, also on a headless resume", () => {
    expect(
      buildAgentCommand("codex", "go", SETTINGS, {
        model: "openai.gpt-5.4",
        provider: { kind: "bedrock", region: "us-west-2" },
      }),
    ).toBe(
      "env AWS_REGION='us-west-2' AWS_DEFAULT_REGION='us-west-2' " +
        `codex --dangerously-bypass-approvals-and-sandbox -m 'openai.gpt-5.4' -c 'model_provider="amazon-bedrock"' 'go'`,
    );
    expect(
      buildAgentCommand("codex", undefined, SETTINGS, {
        mode: "headless",
        resumeSessionId: "abc",
        provider: { kind: "bedrock", region: "us-west-2" },
      }),
    ).toContain(
      `codex exec resume --dangerously-bypass-approvals-and-sandbox -c 'model_provider="amazon-bedrock"' 'abc'`,
    );
  });

  it("ignores a provider for agents it can't serve", () => {
    expect(
      buildAgentCommand("gemini", "x", SETTINGS, {
        provider: { kind: "bedrock", region: "us-west-2" },
      }),
    ).toBe(`gemini -i 'x'`);
  });

  it("quotes a hostile region instead of running it", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { kind: "bedrock", region: "x'; rm -rf / #" },
    });
    expect(cmd).toContain(`AWS_REGION='x'\\''; rm -rf / #'`);
  });
});

describe("buildAgentCommand with a LiteLLM provider", () => {
  const litellm = {
    kind: "litellm" as const,
    baseUrl: "http://litellm.lan:4000",
    apiKeyEnv: "LITELLM_API_KEY",
    model: { id: "local-coder", contextWindow: 262144 },
  };

  it("points Claude Code at the proxy with the key from the machine's env var", () => {
    expect(
      buildAgentCommand("claude-code", "hi", SETTINGS, { model: "local-coder", provider: litellm }),
    ).toBe(
      'env -u ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN="$LITELLM_API_KEY" ' +
        "ANTHROPIC_BASE_URL='http://litellm.lan:4000' CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1' " +
        "ANTHROPIC_DEFAULT_OPUS_MODEL='local-coder' ANTHROPIC_DEFAULT_SONNET_MODEL='local-coder' " +
        "ANTHROPIC_DEFAULT_HAIKU_MODEL='local-coder' ANTHROPIC_DEFAULT_FABLE_MODEL='local-coder' " +
        "ANTHROPIC_SMALL_FAST_MODEL='local-coder' CLAUDE_CODE_SUBAGENT_MODEL='local-coder' " +
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS='262144' " +
        `${CLAUDE} --model 'local-coder' 'hi'`,
    );
  });

  it("leaves the token to the machine's own env when no variable is named", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { kind: "litellm", baseUrl: "http://litellm.lan:4000" },
    });
    expect(cmd).toBe(
      "env -u ANTHROPIC_API_KEY ANTHROPIC_BASE_URL='http://litellm.lan:4000' " +
        `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS='1' ${CLAUDE}`,
    );
  });

  it("never expands a variable name that isn't one", () => {
    const cmd = buildAgentCommand("claude-code", undefined, SETTINGS, {
      provider: { ...litellm, apiKeyEnv: "X; rm -rf /" },
    });
    expect(cmd).not.toContain("rm -rf");
    expect(cmd).not.toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("ignores a LiteLLM provider for Codex", () => {
    expect(buildAgentCommand("codex", "x", SETTINGS, { provider: litellm })).toBe(
      `codex --dangerously-bypass-approvals-and-sandbox 'x'`,
    );
  });
});

describe("listAwsProfiles", () => {
  it("reads profile names (never keys) from the config and credentials files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aws-"));
    mkdirSync(join(dir, ".aws"));
    writeFileSync(
      join(dir, ".aws", "config"),
      "[default]\nregion = us-west-2\n[profile bedrock]\nsso_session = x\n[sso-session x]\n",
    );
    writeFileSync(
      join(dir, ".aws", "credentials"),
      "[ci]\naws_access_key_id = AKIA...\n[default]\n",
    );
    expect(listAwsProfiles({ HOME: dir })).toEqual(["bedrock", "ci", "default"]);
  });

  it("is empty without an AWS setup", () => {
    expect(listAwsProfiles({ HOME: mkdtempSync(join(tmpdir(), "aws-none-")) })).toEqual([]);
  });
});

describe("Claude Code effort levels", () => {
  const caps = { permissionModes: null, effort: true, effortLevels: ["low", "medium", "high"] };
  it("passes an effort this claude lists, and leaves out one it doesn't", () => {
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "high", claudeCaps: caps }),
    ).toBe(`${CLAUDE} --effort 'high'`);
    expect(
      buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "max", claudeCaps: caps }),
    ).toBe(CLAUDE);
    // Unknown list: passed as asked.
    expect(buildAgentCommand("claude-code", undefined, SETTINGS, { effort: "max" })).toBe(
      `${CLAUDE} --effort 'max'`,
    );
  });
});
