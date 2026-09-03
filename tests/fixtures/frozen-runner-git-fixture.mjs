// Simulated git state for the FREEZE SIMULATION test.
//
// Presents a world in which `maf-scoring-runner-v1` already exists locally and on origin and peels
// to the executing HEAD, while every other frozen tag verifies normally. This lets the REAL
// production command composition be driven end to end BEFORE the tag exists -- which is the only
// way to prove that creating the tag activates scoring without a source change, short of creating
// it.
//
// It cannot cause a real provider call: the executable this fixture names is the fake Claude CLI.

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SUITE_SHA = "92f13ae67802dd0049ca001f70839a9451120900";
export const PROTOCOL_V1_SHA = "b183b20a08b1d4f6902bffea49fe139f80cad4e9";
export const PROTOCOL_V2_SHA = "b086b21e1e66f4a3c039d5c60079d9311eb82e15";
export const ANALYSIS_SHA = "de02da424e8d639213cf03aadfd9566ab3313adb";

/** The commit the simulated runner tag points at, and the simulated executing HEAD. */
export const SIMULATED_HEAD = process.env.MAF_SIM_HEAD ?? "a".repeat(40);

/**
 * Which blocking variant to simulate. Empty means the fully-authorized world.
 *   RUNNER_TAG_ABSENT | RUNNER_REMOTE_ABSENT | RUNNER_WRONG_SHA | DIRTY_WORKTREE
 */
const variant = process.env.MAF_SIM_VARIANT ?? "";

const refs = () => {
  const map = {
    "local:maf-suite-freeze-v1": SUITE_SHA,
    "remote:maf-suite-freeze-v1": SUITE_SHA,
    "local:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "remote:maf-experiment-protocol-v1": PROTOCOL_V1_SHA,
    "local:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "remote:maf-experiment-protocol-v2": PROTOCOL_V2_SHA,
    "local:maf-experiment-analysis-v1": ANALYSIS_SHA,
    "remote:maf-experiment-analysis-v1": ANALYSIS_SHA,
    "local:maf-scoring-runner-v1": SIMULATED_HEAD,
    "remote:maf-scoring-runner-v1": SIMULATED_HEAD,
  };
  if (variant === "RUNNER_TAG_ABSENT") {
    delete map["local:maf-scoring-runner-v1"];
    delete map["remote:maf-scoring-runner-v1"];
  }
  if (variant === "RUNNER_REMOTE_ABSENT") delete map["remote:maf-scoring-runner-v1"];
  if (variant === "RUNNER_WRONG_SHA") {
    map["local:maf-scoring-runner-v1"] = "b".repeat(40);
    map["remote:maf-scoring-runner-v1"] = "b".repeat(40);
  }
  return map;
};

/** Mirrors the real git surface the runner uses: rev-parse, status, ls-remote. */
export const git = async (args) => {
  const map = refs();
  if (args[0] === "rev-parse" && args[1]?.startsWith("refs/tags/")) {
    const tag = args[1].replace("refs/tags/", "").replace("^{commit}", "");
    const sha = map[`local:${tag}`];
    if (!sha) throw new Error(`unknown revision ${tag}`);
    return `${sha}\n`;
  }
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${SIMULATED_HEAD}\n`;
  if (args[0] === "status") return variant === "DIRTY_WORKTREE" ? " M src/thing.ts\n" : "";
  if (args[0] === "ls-remote") {
    const tag = args[2]?.replace("refs/tags/", "").replace("^{}", "") ?? "";
    const sha = map[`remote:${tag}`];
    if (!sha) return "";
    // The tag-object sha deliberately differs from the peeled commit sha.
    return `${"f".repeat(40)}\trefs/tags/${tag}\n${sha}\trefs/tags/${tag}^{}\n`;
  }
  return "";
};

/** The fake Claude CLI. Emits canned stream-json; never contacts a provider. */
export const claudeCommand = path.join(here, "fake-claude-cli.mjs");

/** Pristine fixture the simulated participants start from. */
export const fixtureRoot = path.resolve(
  here,
  "..",
  "..",
  "evaluation",
  "experiments",
  "real",
  "fixtures",
  "preflight-phase",
  "preflight-task",
  "public",
  "repo",
);

/**
 * Probe overrides for the simulated executable.
 *
 * `pinClaudeExecutable` already exposes `resolve`/`checkAuth` injection points; the simulation uses
 * them because the fake CLI is a .mjs script that cannot be exec'd directly for `--version`. The
 * production pinning logic (absolute-path requirement, single-path invariant, first-party rules)
 * runs completely unchanged against these results.
 */
export const resolve = async () => ({
  resolved: true,
  path: claudeCommand,
  version: "2.1.251 (fake)",
  detail: "resolved (simulated)",
});

export const checkAuth = async () => ({
  checked: true,
  loggedIn: process.env.MAF_SIM_VARIANT !== "LOGGED_OUT",
  authMethod: process.env.MAF_SIM_VARIANT === "API_KEY_AUTH" ? "api_key" : "claude.ai",
  apiProvider: process.env.MAF_SIM_VARIANT === "THIRD_PARTY" ? "thirdParty" : "firstParty",
  detail: "simulated auth probe",
});
