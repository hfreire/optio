import { describe, expect, it } from "vitest";
import {
  applyClaudeConfig,
  claudeConfigReport,
  hookExecutables,
  mapClaudeConfigFiles,
  mergeClaudeSettings,
  selectClaudeConfigSource,
  type ClaudeConfigFile,
} from "./claude-config.js";

const file = (relativePath: string, text = "x", executable = false): ClaudeConfigFile => ({
  relativePath,
  content: Buffer.from(text),
  executable,
});

describe("mergeClaudeSettings", () => {
  const none = () => false;

  it("lets Optio's keys win over the config's", () => {
    const merged = mergeClaudeSettings(
      { hasCompletedOnboarding: true, model: "opus", effortLevel: "high" },
      { hasCompletedOnboarding: false, model: "haiku", effortLevel: "low", theme: "dark" },
      none,
    );
    expect(merged).toEqual({
      hasCompletedOnboarding: true,
      model: "opus",
      effortLevel: "high",
      theme: "dark",
    });
  });

  it("drops the config's model and effort when Optio sets none", () => {
    const merged = mergeClaudeSettings(
      { hasCompletedOnboarding: true },
      { model: "haiku", effortLevel: "low" },
      none,
    );
    expect(merged).toEqual({ hasCompletedOnboarding: true });
  });

  it("never takes permissions from the config", () => {
    const merged = mergeClaudeSettings(
      { hasCompletedOnboarding: true },
      { permissions: { defaultMode: "plan", deny: ["Bash"] } },
      none,
    );
    expect(merged).not.toHaveProperty("permissions");
    const withBase = mergeClaudeSettings(
      { permissions: { defaultMode: "bypassPermissions" } },
      { permissions: { deny: ["Bash"] } },
      none,
    );
    expect(withBase.permissions).toEqual({ defaultMode: "bypassPermissions" });
  });

  it("takes hooks, attribution, statusLine and plugins from the config", () => {
    const config = {
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }] },
      attribution: { commit: "" },
      statusLine: { type: "command", command: "~/.claude/statusline.sh" },
      enabledPlugins: { "a@b": true },
    };
    expect(mergeClaudeSettings({ hasCompletedOnboarding: true }, config, none)).toEqual({
      hasCompletedOnboarding: true,
      ...config,
    });
  });

  it("merges env with Optio's keys winning, and drops the config's clashing ones", () => {
    const merged = mergeClaudeSettings(
      { env: { A: "optio" } },
      { env: { A: "config", B: "config", ANTHROPIC_BASE_URL: "https://evil" } },
      (key) => key === "ANTHROPIC_BASE_URL",
    );
    expect(merged.env).toEqual({ A: "optio", B: "config" });
  });

  it("ignores a config env that is not an object", () => {
    expect(mergeClaudeSettings({}, { env: "nope" }, none)).toEqual({});
  });
});

describe("mapClaudeConfigFiles", () => {
  const map = (files: ClaudeConfigFile[], installed: string[] = []) =>
    mapClaudeConfigFiles(files, new Set(installed));

  it("writes every file under ~/.claude", () => {
    const { setupFiles } = map([file("CLAUDE.md", "hi"), file("commands/a.md")]);
    expect(setupFiles.map((f) => f.path)).toEqual([
      "/home/agent/.claude/CLAUDE.md",
      "/home/agent/.claude/commands/a.md",
    ]);
    expect(Buffer.from(setupFiles[0].contentBase64!, "base64").toString()).toBe("hi");
  });

  it("leaves out .git, root README*, settings.local.json and nested paths that escape", () => {
    const { setupFiles } = map([
      file(".git/config"),
      file("README.md"),
      file("readme.txt"),
      file("settings.local.json"),
      file("../evil"),
      file("skills/a/README.md"),
    ]);
    expect(setupFiles.map((f) => f.path)).toEqual(["/home/agent/.claude/skills/a/README.md"]);
  });

  it("returns settings.json apart from the files", () => {
    const { setupFiles, settings } = map([file("settings.json", '{"a":1}'), file("CLAUDE.md")]);
    expect(settings).toBe('{"a":1}');
    expect(setupFiles.map((f) => f.path)).toEqual(["/home/agent/.claude/CLAUDE.md"]);
  });

  it("makes hooks/ and *.sh executable, and keeps a source exec bit", () => {
    const { setupFiles } = map([
      file("hooks/guard.py"),
      file("hooks/lib/x"),
      file("scripts/run.sh"),
      file("bin/tool", "x", true),
      file("CLAUDE.md"),
    ]);
    const exec = Object.fromEntries(
      setupFiles.map((f) => [f.path.split(".claude/")[1], !!f.executable]),
    );
    expect(exec).toEqual({
      "hooks/guard.py": true,
      "hooks/lib/x": true,
      "scripts/run.sh": true,
      "bin/tool": true,
      "CLAUDE.md": false,
    });
  });

  it("skips a skill an installed skill of the same name replaces, with a note", () => {
    const { setupFiles, notes } = map(
      [file("skills/tdd/SKILL.md"), file("skills/tdd/ref.md"), file("skills/other/SKILL.md")],
      ["tdd"],
    );
    expect(setupFiles.map((f) => f.path)).toEqual(["/home/agent/.claude/skills/other/SKILL.md"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("tdd");
  });

  it("does not treat a similarly named directory as the installed skill", () => {
    const { setupFiles, notes } = map([file("skills/tdd-extra/SKILL.md")], ["tdd"]);
    expect(setupFiles).toHaveLength(1);
    expect(notes).toEqual([]);
  });
});

describe("hookExecutables", () => {
  const hooks = (...commands: string[]) => ({
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: commands.map((command) => ({ type: "command", command })) },
      ],
    },
  });
  const exes = (...commands: string[]) => hookExecutables(hooks(...commands)).map((h) => h.exe);

  it("takes the first word", () => {
    expect(exes("jq -r .x", "python3 ~/.claude/hooks/a.py --flag")).toEqual(["jq", "python3"]);
  });

  it("skips leading env assignments and env", () => {
    expect(exes("FOO=1 BAR='a b' node x.js", "env A=1 rg foo")).toEqual(["node", "rg"]);
  });

  it("looks inside sh -c wrappers", () => {
    expect(exes(`sh -c 'FOO=1 terminal-notifier -message x'`, 'bash -c "afplay a.wav"')).toEqual([
      "terminal-notifier",
      "afplay",
    ]);
  });

  it("skips shell builtins, unresolved variables and non-command hooks", () => {
    expect(exes("echo hi", "cd /x && foo", "$CLAUDE_PLUGIN_ROOT/a.sh", "true")).toEqual([]);
    expect(
      hookExecutables({ hooks: { Stop: [{ hooks: [{ type: "prompt", prompt: "x" }] }] } }),
    ).toEqual([]);
  });

  it("keeps ~ and $HOME paths for the pod to resolve", () => {
    expect(exes("~/.claude/hooks/a.sh", "$HOME/.claude/hooks/b.sh", "${HOME}/c.sh")).toEqual([
      "~/.claude/hooks/a.sh",
      "$HOME/.claude/hooks/b.sh",
      "${HOME}/c.sh",
    ]);
  });

  it("dedupes and tolerates a malformed hooks block", () => {
    expect(exes("jq a", "jq b")).toEqual(["jq"]);
    expect(hookExecutables({ hooks: "nope" })).toEqual([]);
    expect(hookExecutables({})).toEqual([]);
  });
});

describe("claudeConfigReport", () => {
  it("is null when there is nothing to say", () => {
    expect(claudeConfigReport([], [])).toBeNull();
  });

  it("encodes notes and executables as base64 JSON", () => {
    const encoded = claudeConfigReport(["n"], [{ event: "Stop", exe: "jq" }]);
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString())).toEqual({
      notes: ["n"],
      executables: [{ event: "Stop", exe: "jq" }],
    });
  });
});

describe("selectClaudeConfigSource", () => {
  const src = (id: string, repoUrl: string | null, workspaceId: string | null = "w") => ({
    id,
    repoUrl,
    workspaceId,
  });

  it("returns null with no sources", () => {
    expect(selectClaudeConfigSource([], "r", "w")).toBeNull();
  });

  it("uses the workspace's for a repo with no override, and for no repo", () => {
    const rows = [src("ws", null), src("other", "https://x/other")];
    expect(selectClaudeConfigSource(rows, "https://x/a", "w")?.id).toBe("ws");
    expect(selectClaudeConfigSource(rows, null, "w")?.id).toBe("ws");
  });

  it("replaces the workspace's with the repo's own", () => {
    const rows = [src("ws", null), src("repo", "https://x/a")];
    expect(selectClaudeConfigSource(rows, "https://x/a", "w")?.id).toBe("repo");
  });

  it("ignores other workspaces' rows and prefers the caller's over a global one", () => {
    const rows = [src("foreign", null, "z"), src("global", null, null), src("mine", null, "w")];
    expect(selectClaudeConfigSource(rows, null, "w")?.id).toBe("mine");
    expect(selectClaudeConfigSource(rows.slice(0, 2), null, "w")?.id).toBe("global");
  });
});

describe("applyClaudeConfig", () => {
  const adapterSettings = {
    path: "/home/agent/.claude/settings.json",
    content: JSON.stringify({ hasCompletedOnboarding: true, model: "opus" }),
  };
  const apply = (existing: Array<{ path: string; content: string }>, files: ClaudeConfigFile[]) =>
    applyClaudeConfig(existing, files, new Set(), () => false);
  const settingsOf = (files: Array<{ path: string; content: string }>) =>
    JSON.parse(files.find((f) => f.path.endsWith("/settings.json"))!.content);

  it("changes nothing for an empty config", () => {
    const out = apply([adapterSettings], []);
    expect(out.setupFiles).toEqual([adapterSettings]);
    expect(out.report).toBeNull();
  });

  it("merges the config's settings into the adapter's file in place", () => {
    const out = apply(
      [{ path: ".mcp.json", content: "{}" }, adapterSettings],
      [file("settings.json", JSON.stringify({ model: "haiku", attribution: { commit: "" } }))],
    );
    expect(out.setupFiles.filter((f) => f.path.endsWith("/settings.json"))).toHaveLength(1);
    expect(settingsOf(out.setupFiles)).toEqual({
      hasCompletedOnboarding: true,
      model: "opus",
      attribution: { commit: "" },
    });
    expect(out.setupFiles[0].path).toBe(".mcp.json");
  });

  it("writes settings on top of a bare base when the runtime has no adapter step", () => {
    const out = apply([], [file("settings.json", JSON.stringify({ theme: "dark" }))]);
    expect(settingsOf(out.setupFiles)).toEqual({ hasCompletedOnboarding: true, theme: "dark" });
  });

  it("leaves the adapter's settings alone when the config has none", () => {
    const out = apply([adapterSettings], [file("CLAUDE.md")]);
    expect(out.setupFiles[0]).toEqual(adapterSettings);
    expect(out.setupFiles).toHaveLength(2);
  });

  it("ignores a settings.json that is not an object, with a note", () => {
    const out = apply([adapterSettings], [file("settings.json", "[1]")]);
    expect(out.setupFiles).toEqual([adapterSettings]);
    expect(JSON.parse(Buffer.from(out.report!, "base64").toString()).notes).toHaveLength(1);
  });

  it("reports the hooks' executables and skipped skills", () => {
    const out = applyClaudeConfig(
      [adapterSettings],
      [
        file(
          "settings.json",
          JSON.stringify({
            hooks: { Stop: [{ hooks: [{ type: "command", command: "terminal-notifier -x" }] }] },
          }),
        ),
        file("skills/tdd/SKILL.md"),
      ],
      new Set(["tdd"]),
      () => false,
    );
    const report = JSON.parse(Buffer.from(out.report!, "base64").toString());
    expect(report.executables).toEqual([{ event: "Stop", exe: "terminal-notifier" }]);
    expect(report.notes).toHaveLength(1);
  });
});
