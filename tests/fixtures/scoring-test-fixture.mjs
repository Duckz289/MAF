// COMPLETE test-seam module for the Runner v2 freeze simulation.
//
// Runner v1's equivalent fixture was OPTIONAL: omit `--git-fixture` and the command silently used
// real git, the real PATH-resolved Claude executable, the real auth probe and the real fixtures.
// That optionality is what incident maf-scoring-incident-2026-09-03-v1 exploited. In v2 the CLI
// refuses to run `execute` under a TEST context unless a module supplies EVERY field below, so a
// partially-specified fixture cannot leave one real dependency wired in.
//
// The provider seam is now separate from the git seam. `testDoubleProviderPath` names a file that
// must independently pass `approveTestDoubleProvider` -- marker inside its bytes, inside a declared
// test-controlled root. Simulating a frozen tag world therefore grants no power over which binary
// runs, and vice versa.
//
// DETERMINISM ACROSS REAL TAG STATE. Every tag this fixture reports is invented here. The
// simulation behaves identically whether the real machine has no runner tag, maf-scoring-runner-v1,
// maf-scoring-runner-v2, or tags that do not exist yet -- because it never asks the real repository
// anything.
//
// DETERMINISM ACROSS ENVIRONMENT. The execution context below is CONSTRUCTED, not sniffed, so a
// child process with a sanitized environment -- no VITEST_*, no NODE_ENV, nothing -- still runs as
// TEST. That is the audit's Repair 3 stated as a property of this file: stripping every variable
// cannot promote a simulation into a production run.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestExecutionContext } from "../../evaluation/experiments/scoring/lib/internal/test-support.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * THE AUTHENTIC TEST EXECUTION CONTEXT for every invocation driven through this fixture.
 *
 * The CLI cannot construct one: it builds PRODUCTION and has no flag, variable or branch that yields
 * TEST. The seam supplies it, and the CLI then verifies it is runtime-authentic before believing it
 * -- so exporting `{ kind: "TEST" }` here would be refused, not trusted.
 *
 * Because this module and the CLI are loaded into the same process, both reach the same instance of
 * the private registry that makes the check meaningful.
 *
 * Note the direction of the capability this grants: a TEST context can only ever spawn an approved
 * test double. There is no seam, flag or environment value anywhere that turns a test into a
 * production run.
 */
export const executionContext = createTestExecutionContext("tests/fixtures/scoring-test-fixture");

export const SUITE_SHA = "92f13ae67802dd0049ca001f70839a9451120900";
export const PROTOCOL_V1_SHA = "b183b20a08b1d4f6902bffea49fe139f80cad4e9";
export const PROTOCOL_V2_SHA = "b086b21e1e66f4a3c039d5c60079d9311eb82e15";
export const ANALYSIS_SHA = "de02da424e8d639213cf03aadfd9566ab3313adb";

/**
 * The incident record, now a MANDATORY frozen authority for paid execution.
 *
 * Simulated at its real commit because the gate proves it exactly as it proves the suite and the
 * protocol. The fixture NAMES it and imports nothing from it: no incident observation enters
 * campaign state, the DVS denominator, aggregation, or any report.
 */
export const INCIDENT_SHA = "895797e0c58099c763e206b851ba144d287394db";

/** The real, historical Runner v1 commit. Simulated here only to prove it can never be selected. */
export const RUNNER_V1_SHA = "5484808a764c6c579ee94c269fb20c07383ddbdd";

/** The commit the simulated runner tag points at, and the simulated executing HEAD. */
export const SIMULATED_HEAD = process.env.MAF_SIM_HEAD ?? "a".repeat(40);

/**
 * Which world to simulate. Empty means fully authorized.
 *
 *   RUNNER_TAG_ABSENT | RUNNER_REMOTE_ABSENT | RUNNER_WRONG_SHA | DIRTY_WORKTREE
 *   API_KEY_AUTH | THIRD_PARTY | LOGGED_OUT
 *   RUNNER_V1_ONLY      -- v1 exists, v2 does not: scoring must refuse
 *   HEAD_IS_RUNNER_V1   -- the executing revision IS Runner v1: must refuse as DEPRECATED
 *   FUTURE_TAGS_PRESENT -- v1, v2 and later runner tags all exist: must be unaffected
 *
 * Incident-freeze worlds (the incident record is a mandatory authority for paid execution):
 *   INCIDENT_TAG_ABSENT      -- absent locally and remotely
 *   INCIDENT_LOCAL_ONLY      -- present locally, never published
 *   INCIDENT_REMOTE_ONLY     -- published, absent locally
 *   INCIDENT_WRONG_LOCAL_SHA -- local tag peels to the wrong commit
 *   INCIDENT_WRONG_REMOTE_SHA-- remote tag peels to the wrong commit
 */
const variant = process.env.MAF_SIM_VARIANT ?? "";

const headSha = variant === "HEAD_IS_RUNNER_V1" ? RUNNER_V1_SHA : SIMULATED_HEAD;

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
    "local:maf-scoring-incident-2026-09-03-v1": INCIDENT_SHA,
    "remote:maf-scoring-incident-2026-09-03-v1": INCIDENT_SHA,
    // Runner v1 is present in EVERY simulated world, exactly as it is on the real machine. Its
    // presence must never make a difference to anything.
    "local:maf-scoring-runner-v1": RUNNER_V1_SHA,
    "remote:maf-scoring-runner-v1": RUNNER_V1_SHA,
    "local:maf-scoring-runner-v2": headSha,
    "remote:maf-scoring-runner-v2": headSha,
  };
  if (variant === "RUNNER_TAG_ABSENT" || variant === "RUNNER_V1_ONLY") {
    delete map["local:maf-scoring-runner-v2"];
    delete map["remote:maf-scoring-runner-v2"];
  }
  if (variant === "RUNNER_REMOTE_ABSENT") delete map["remote:maf-scoring-runner-v2"];
  if (variant === "INCIDENT_TAG_ABSENT" || variant === "INCIDENT_REMOTE_ONLY") {
    delete map["local:maf-scoring-incident-2026-09-03-v1"];
  }
  if (variant === "INCIDENT_TAG_ABSENT" || variant === "INCIDENT_LOCAL_ONLY") {
    delete map["remote:maf-scoring-incident-2026-09-03-v1"];
  }
  if (variant === "INCIDENT_WRONG_LOCAL_SHA") {
    map["local:maf-scoring-incident-2026-09-03-v1"] = "c".repeat(40);
  }
  if (variant === "INCIDENT_WRONG_REMOTE_SHA") {
    map["remote:maf-scoring-incident-2026-09-03-v1"] = "c".repeat(40);
  }
  if (variant === "RUNNER_WRONG_SHA") {
    map["local:maf-scoring-runner-v2"] = "b".repeat(40);
    map["remote:maf-scoring-runner-v2"] = "b".repeat(40);
  }
  if (variant === "FUTURE_TAGS_PRESENT") {
    // Runner tags this revision has never heard of. A correct implementation resolves the tag it
    // names and ignores every other, so these must change nothing at all.
    map["local:maf-scoring-runner-v3"] = "d".repeat(40);
    map["remote:maf-scoring-runner-v3"] = "d".repeat(40);
    map["local:maf-scoring-runner-v4-rc1"] = "e".repeat(40);
    map["remote:maf-scoring-runner-v4-rc1"] = "e".repeat(40);
    map["local:maf-unrelated-future-thing"] = "9".repeat(40);
    map["remote:maf-unrelated-future-thing"] = "9".repeat(40);
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
  if (args[0] === "rev-parse" && args[1] === "HEAD") return `${headSha}\n`;
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

/**
 * The approved TEST_DOUBLE provider.
 *
 * Absolute, carrying MAF_SCORING_TEST_DOUBLE_PROVIDER_V2 in its own bytes, and inside
 * tests/fixtures/ which declares itself a test-controlled root. All three are re-verified by the
 * runner; naming a file here grants nothing on its own.
 */
export const testDoubleProviderPath = path.join(here, "fake-claude-cli.mjs");

/** Pristine fixture the simulated participants start from. */
export const participantFixtureRoot = path.resolve(
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
 * Probe seams for the simulated executable.
 *
 * The fake CLI is a .mjs script that cannot be exec'd directly for `--version`, so resolution and
 * auth are injected. The production pinning logic (absolute-path requirement, single-path
 * invariant, first-party rules) runs completely unchanged against these results, and the identity
 * approval that gates the spawn reads the real file regardless of what these return.
 */
export const resolve = async () => ({
  resolved: true,
  path: testDoubleProviderPath,
  version: "2.1.251 (fake)",
  detail: "resolved (simulated)",
});

export const checkAuth = async () => ({
  checked: true,
  loggedIn: variant !== "LOGGED_OUT",
  authMethod: variant === "API_KEY_AUTH" ? "api_key" : "claude.ai",
  apiProvider: variant === "THIRD_PARTY" ? "thirdParty" : "firstParty",
  detail: "simulated auth probe",
});
