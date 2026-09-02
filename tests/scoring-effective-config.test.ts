import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVE_CONFIG_FILENAMES,
  claudeConfigDir,
  inspectEffectiveClaudeConfig,
  KNOWN_ALTERNATE_ROUTES,
  ROUTING_ENV_KEYS,
} from "../evaluation/experiments/scoring/lib/effective-config-gate";

let home: string;
let configDir: string;

const writeConfig = async (filename: string, contents: unknown): Promise<void> => {
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, filename), JSON.stringify(contents, null, 2), "utf8");
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "maf-claude-home-"));
  configDir = path.join(home, ".claude");
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 3 });
});

describe("config directory path construction", () => {
  it("joins the profile and .claude rather than concatenating them", () => {
    // The bug this guards: "C:\\Users\\Admin" + ".claude" -> "C:\\Users\\Admin.claude".
    const dir = claudeConfigDir("C:\\Users\\Admin");
    expect(dir).toBe(path.join("C:\\Users\\Admin", ".claude"));
    expect(dir.endsWith(`${path.sep}.claude`)).toBe(true);
    expect(dir).not.toBe("C:\\Users\\Admin.claude");
  });

  it("defaults to the real home directory", () => {
    expect(claudeConfigDir()).toBe(path.join(homedir(), ".claude"));
  });
});

describe("active configuration detection", () => {
  it("passes when no active config redirects the CLI", async () => {
    await writeConfig("settings.json", {
      env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" },
      theme: "dark",
    });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(true);
    expect(report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN")?.passed).toBe(true);
  });

  it.each(ROUTING_ENV_KEYS)("detects %s in an active settings file", async (key) => {
    await writeConfig("settings.json", { env: { [key]: "some-value" } });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(false);
    const check = report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN");
    expect(check?.passed).toBe(false);
    expect(check?.findings.some((f) => f.key === key)).toBe(true);
  });

  it("detects the Stali base URL routing that caused the invalid preflight", async () => {
    await writeConfig("settings.json", {
      env: {
        ANTHROPIC_BASE_URL: "https://api.stali.vn/v1",
        ANTHROPIC_AUTH_TOKEN: "sk-super-secret-value",
        ANTHROPIC_MODEL: "req/kimi-k3",
      },
    });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(false);
    const findings =
      report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN")?.findings ?? [];
    expect(findings.map((f) => f.key).sort()).toEqual([
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_MODEL",
    ]);
    expect(findings.some((f) => f.matchedRoute === "api.stali.vn")).toBe(true);
    expect(findings.some((f) => f.matchedRoute === "req/kimi-k3")).toBe(true);
  });

  it("NEVER exposes a configuration value, only the key that was set", async () => {
    const secret = "sk-ant-do-not-leak-me-0123456789";
    await writeConfig("settings.json", { env: { ANTHROPIC_AUTH_TOKEN: secret } });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  it("inspects settings.local.json as well as settings.json", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    await writeConfig("settings.local.json", {
      env: { ANTHROPIC_BASE_URL: "https://api.stali.vn" },
    });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(false);
    expect(report.inspectedFiles).toHaveLength(2);
  });

  it("fails closed when an active config file cannot be parsed", async () => {
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(configDir, "settings.json"), "{ not valid json", "utf8");
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(false);
    const check = report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN");
    expect(check?.findings[0]?.detail).toMatch(/cannot be proven clean/u);
  });

  it("finds routing nested anywhere in the settings tree, not just under env", async () => {
    await writeConfig("settings.json", {
      profiles: { work: { overrides: { ANTHROPIC_BASE_URL: "https://api.stali.vn" } } },
    });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(false);
  });
});

describe("historical material is NOT active configuration", () => {
  it("ignores a timestamped settings backup containing the exact bad routing", async () => {
    await writeConfig("settings.json", { env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" } });
    // This mirrors the real machine: settings.backup-maf-preflight-20260901.json still holds the
    // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN routing that produced the invalid preflight.
    await writeConfig("settings.backup-maf-preflight-20260901.json", {
      env: {
        ANTHROPIC_BASE_URL: "https://api.stali.vn/v1",
        ANTHROPIC_AUTH_TOKEN: "sk-old-token",
        ANTHROPIC_MODEL: "req/kimi-k3",
      },
    });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(true);
    expect(report.inspectedFiles).toHaveLength(1);
    expect(report.inspectedFiles[0]).toMatch(/settings\.json$/u);
  });

  it("ignores backups/, cache/, sessions/, projects/ and history", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    for (const dir of ["backups", "cache", "sessions", "projects"]) {
      await mkdir(path.join(configDir, dir), { recursive: true });
      await writeFile(
        path.join(configDir, dir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.stali.vn" } }),
        "utf8",
      );
    }
    await writeFile(
      path.join(configDir, "history.jsonl"),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-historical" } }),
      "utf8",
    );
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.clean).toBe(true);
    expect(report.excludedPaths.length).toBeGreaterThanOrEqual(5);
  });

  it("only ever loads the documented active filenames", () => {
    expect([...ACTIVE_CONFIG_FILENAMES]).toEqual(["settings.json", "settings.local.json"]);
  });
});

describe("controller environment and child forwarding are reported separately", () => {
  it("flags controller environment routing without blaming the config file", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "https://api.stali.vn" },
    });
    expect(report.clean).toBe(false);
    expect(report.checks.find((c) => c.id === "CONTROLLER_ENVIRONMENT_CLEAN")?.passed).toBe(false);
    expect(report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN")?.passed).toBe(true);
  });

  it("does NOT block on a first-party base URL that is never forwarded", async () => {
    // The real machine has ANTHROPIC_BASE_URL=https://api.anthropic.com. That is the official
    // endpoint and the adapter does not forward it, so it redirects nothing. Blocking here would
    // make the gate permanently unpassable and invite someone to weaken it.
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      forwardedEnvironmentKeys: [],
    });
    expect(report.clean).toBe(true);
    const check = report.checks.find((c) => c.id === "CONTROLLER_ENVIRONMENT_CLEAN");
    expect(check?.passed).toBe(true);
    // The presence is still REPORTED, just not treated as redirection.
    expect(check?.findings.map((f) => f.key)).toContain("ANTHROPIC_BASE_URL");
    expect(check?.detail).toMatch(/none redirecting away from first-party/u);
  });

  it("blocks a base URL pointing at any non-first-party host", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "https://proxy.example.test/v1" },
    });
    expect(report.clean).toBe(false);
    expect(report.checks.find((c) => c.id === "CONTROLLER_ENVIRONMENT_CLEAN")?.passed).toBe(false);
  });

  it("blocks an unparseable base URL rather than assuming it is fine", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "not-a-url" },
    });
    expect(report.clean).toBe(false);
  });

  it("treats a non-forwarded credential/model override as advisory, not blocking", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_API_KEY: "sk-not-forwarded" },
      forwardedEnvironmentKeys: [],
    });
    expect(report.clean).toBe(true);
    expect(
      report.checks.find((c) => c.id === "CONTROLLER_ENVIRONMENT_CLEAN")?.findings,
    ).toHaveLength(1);
  });

  it("blocks the same credential override once it WOULD reach the child", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_API_KEY: "sk-forwarded" },
      forwardedEnvironmentKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(report.clean).toBe(false);
    expect(report.checks.find((c) => c.id === "CHILD_ENVIRONMENT_FORWARDING_CLEAN")?.passed).toBe(
      false,
    );
  });

  it("blocks a controller variable that names a known alternate route regardless of key", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_MODEL: "req/kimi-k3" },
    });
    expect(report.clean).toBe(false);
  });

  it("flags forwarding only when a routing key would actually reach the child", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const clean = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "https://api.stali.vn" },
      forwardedEnvironmentKeys: ["PATH", "USERPROFILE"],
    });
    expect(clean.checks.find((c) => c.id === "CHILD_ENVIRONMENT_FORWARDING_CLEAN")?.passed).toBe(
      true,
    );

    const leaking = await inspectEffectiveClaudeConfig({
      home,
      environment: { ANTHROPIC_BASE_URL: "https://api.stali.vn" },
      forwardedEnvironmentKeys: ["PATH", "ANTHROPIC_BASE_URL"],
    });
    expect(leaking.checks.find((c) => c.id === "CHILD_ENVIRONMENT_FORWARDING_CLEAN")?.passed).toBe(
      false,
    );
  });

  it("distinguishes all three surfaces so a refusal names the right one", async () => {
    await writeConfig("settings.json", { theme: "dark" });
    const report = await inspectEffectiveClaudeConfig({ home, environment: {} });
    expect(report.checks.map((c) => c.id)).toEqual([
      "CONTROLLER_ENVIRONMENT_CLEAN",
      "CHILD_ENVIRONMENT_FORWARDING_CLEAN",
      "CLAUDE_EFFECTIVE_CONFIG_CLEAN",
    ]);
  });
});

describe("known alternate routes", () => {
  it("covers the routes this machine was previously redirected through", () => {
    expect([...KNOWN_ALTERNATE_ROUTES]).toEqual([
      "api.stali.vn",
      "req/kimi-k3",
      "req/claude-sonnet-5",
    ]);
  });
});

describe("the real machine's active configuration", () => {
  it("is clean, while its preserved backup is correctly ignored", async () => {
    // Runs against the actual user profile: the gate must pass here today, and must not be
    // tripped by the forensic backup that still sits beside the active settings file.
    const report = await inspectEffectiveClaudeConfig({ forwardedEnvironmentKeys: [] });
    expect(report.checks.find((c) => c.id === "CLAUDE_EFFECTIVE_CONFIG_CLEAN")?.passed).toBe(true);
    expect(report.inspectedFiles.every((f) => !f.includes("backup"))).toBe(true);
  });

  it("passes overall on this machine's real environment and configuration", async () => {
    // This machine sets ANTHROPIC_BASE_URL=https://api.anthropic.com. The gate must recognise that
    // as first-party rather than refusing every future scoring run over a correct setting.
    const report = await inspectEffectiveClaudeConfig({ forwardedEnvironmentKeys: [] });
    expect(report.clean).toBe(true);
  });
});
