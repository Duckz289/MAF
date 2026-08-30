import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { buildAssurancePlan } from "../src/domain/assurance";
import { deriveQualityReport, deriveTrustState } from "../src/domain/quality";
import { deriveRiskVector } from "../src/domain/risk";
import { deriveSemanticSensitivity } from "../src/domain/semantic-sensitivity";
import { deriveSecurityPosture } from "../src/domain/security";
import { attributeVerificationFailure } from "../src/domain/verification-attribution";
import type { AgentAdapter, Sandbox, SandboxDiff, VerifierPort } from "../src/domain/ports";
import type { Run, Task, Verification } from "../src/domain/types";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { CommandVerifier } from "../src/infrastructure/verifier";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

/**
 * Post-pilot hardening regression tests (Findings Aâ€“D). REGRESSION ONLY â€” these pin the general
 * mechanisms the first Native-vs-MAF pilot exposed; they are NOT new effectiveness evidence and
 * must not be cited as a benchmark result.
 */

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

/** Verifier whose outputs follow a scripted sequence â€” lets tests shape failure evidence. */
class ScriptedVerifier implements VerifierPort {
  private calls = 0;
  constructor(
    private readonly script: Array<{
      exitCode: number;
      output: string;
      execution?: Verification["execution"];
    }>,
  ) {}
  async verify(
    run: Run,
    _task: Task,
    _sandbox: Sandbox,
    _diff: SandboxDiff,
  ): Promise<Verification> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls += 1;
    return {
      id: crypto.randomUUID(),
      runId: run.id,
      type: "command",
      state: step.exitCode === 0 ? "VERIFIED" : "QUARANTINED",
      exitCode: step.exitCode,
      output: step.output,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...(step.execution !== undefined ? { execution: step.execution } : {}),
    };
  }
  async cancel(): Promise<void> {}
}

const harness = (verifier: VerifierPort) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
  const telemetry = new DomainTelemetryRecorder();
  const service = new RunService({
    store,
    agent: new NativeCliAdapter({
      command: process.execPath,
      args: [
        "--import",
        pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
        path.resolve("src/fixtures/native-agent.ts"),
      ],
      capabilities: { livePolicyUpdate: true },
    }) as AgentAdapter,
    sandbox: new LocalWorktreeSandbox("", "none"),
    verifier,
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, telemetry, store };
};

// ---------------------------------------------------------------------------
// Finding A: failure attribution â€” a failing verification is not a failing candidate
// ---------------------------------------------------------------------------

describe("verification failure attribution", () => {
  it("classifies a missing command/interpreter as ENVIRONMENT_FAILURE (strong evidence)", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 127,
      output: "sh: 1: pytest: command not found",
    });
    expect(attribution.kind).toBe("ENVIRONMENT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("classifies import failures as UNKNOWN_FAILURE — ambiguous between candidate and toolchain, repair stays available", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output:
        "Traceback (most recent call last):\nModuleNotFoundError: No module named 'packaging'",
    });
    expect(attribution.kind).toBe("UNKNOWN_FAILURE");
    expect(attribution.candidateBound).toBe(false);
    expect(attribution.evidence[0]).toMatch(/ambiguous/iu);
  });

  it("classifies missing-file and test-collection failures as UNKNOWN_FAILURE (candidate-causable)", () => {
    for (const output of [
      "python: can't open file 'verify.py': [Errno 2] No such file or directory",
      "ERROR collecting tests/test_api.py",
    ]) {
      const attribution = attributeVerificationFailure({ exitCode: 1, output });
      expect(attribution.kind).toBe("UNKNOWN_FAILURE");
      expect(attribution.candidateBound).toBe(false);
    }
  });

  it("classifies failed test assertions as CANDIDATE_FAILURE (candidate-bound)", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: "FAILED tests/test_render.py::test_image - AssertionError: expected image bytes",
    });
    expect(attribution.kind).toBe("CANDIDATE_FAILURE");
    expect(attribution.candidateBound).toBe(true);
  });

  it("classifies expected-file misses as CANDIDATE_FAILURE", () => {
    const attribution = attributeVerificationFailure({
      output: "Missing proof.txt",
      expectedFileVerification: true,
    });
    expect(attribution.kind).toBe("CANDIDATE_FAILURE");
    expect(attribution.candidateBound).toBe(true);
  });

  it("returns UNKNOWN_FAILURE rather than guessing when no signature matches", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: "something odd happened",
    });
    expect(attribution.kind).toBe("UNKNOWN_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("attributes infrastructure connectivity evidence to INFRASTRUCTURE_FAILURE", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: "Error: connect ECONNREFUSED 127.0.0.1:5432 â€” database is unavailable",
    });
    expect(attribution.kind).toBe("INFRASTRUCTURE_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Findings A + B integration: attribution drives recovery spend, retry is cheap and first
// ---------------------------------------------------------------------------

describe("environment failure does not trigger candidate repair (integration)", () => {
  it("broken verification environment + correct candidate: no model repair, deterministic retry can clear it", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    // The verification toolchain is broken once (missing package metadata, attribution honestly
    // UNKNOWN), then works. The candidate is correct the whole time.
    const { service } = harness(
      new ScriptedVerifier([
        { exitCode: 1, output: "ModuleNotFoundError: No module named 'packaging'" },
        { exitCode: 0, output: "ok" },
      ]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    const types = events.map((event) => event.type);
    // Case 1: no automatic candidate repair as the FIRST response to an environment failure.
    expect(types).not.toContain("VerificationRepairStarted");
    // The cheap deterministic retry happened and succeeded â€” no model recovery needed (case 3).
    expect(types).toContain("VerificationEnvironmentRetryStarted");
    expect(types).toContain("VerificationEnvironmentRetried");
    const retried = events.find((event) => event.type === "VerificationEnvironmentRetried");
    expect(retried?.data).toMatchObject({ outcome: "VERIFIED" });
    // Attribution is observable with kind + evidence (case 9).
    const attributed = events.find((event) => event.type === "VerificationFailureAttributed");
    expect(attributed?.data).toMatchObject({
      kind: "UNKNOWN_FAILURE",
      candidateBound: false,
      evidence: expect.any(Array),
    });
    expect(completed?.verificationState).toBe("VERIFIED");
  });

  it("persistently broken verification environment: fails closed, no repair spend, never mergeable", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    // STRONG environment evidence (the verifier command itself cannot be spawned) persists
    // across the one deterministic retry: this is genuinely the toolchain, not the candidate.
    const { service } = harness(
      new ScriptedVerifier([{ exitCode: 127, output: "sh: 1: pytest: command not found" }]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { command: "pytest" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "VerificationRepairStarted")).toBe(false);
    const stopped = events.find((event) => event.type === "VerificationRepairStopped");
    expect(stopped?.data).toMatchObject({ reason: "verification-environment-failure" });
    // Trust stays fail-closed: the run is not verified and cannot be merge-eligible (case 1/8).
    expect(completed?.verificationState).toBe("QUARANTINED");
    expect(completed?.trustState).not.toBe("MERGE_ELIGIBLE");
  });

  it("genuine candidate-bound verification failure still gets repair (case 2)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(
      new ScriptedVerifier([
        {
          exitCode: 1,
          output: "FAILED tests/test_output.py::test_exists - AssertionError: missing artifact",
        },
        { exitCode: 0, output: "ok" },
      ]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact and repair succeeds",
      repositoryPath: fixture.path,
      verification: { expectedFile: "repair-proof.txt" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    const repair = events.find((event) => event.type === "VerificationRepairStarted");
    expect(repair).toBeDefined();
    // Finding B: the repair trigger carries its justifying evidence.
    expect(repair?.data).toMatchObject({
      failureKind: "CANDIDATE_FAILURE",
      triggerEvidence: expect.any(Array),
    });
    expect(completed?.verificationState).toBe("VERIFIED");
  });

  it("candidate-caused import failure keeps repair available: UNKNOWN attribution, model repair, verified (repair-pass)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    // Import failure shapes are ambiguous (candidate's own broken import vs broken toolchain),
    // so attribution is UNKNOWN — never guessed into ENVIRONMENT — and the repair ladder stays
    // open: retry once, then model repair fixes the candidate's actual missing import.
    const { service } = harness(
      new ScriptedVerifier([
        { exitCode: 1, output: "node:internal/process: Cannot find module 'packaging'" },
        { exitCode: 1, output: "node:internal/process: Cannot find module 'packaging'" },
        { exitCode: 0, output: "ok" },
      ]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact and repair succeeds",
      repositoryPath: fixture.path,
      verification: { command: "node verify.js" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    const attributed = events.find((event) => event.type === "VerificationFailureAttributed");
    expect(attributed?.data).toMatchObject({ kind: "UNKNOWN_FAILURE", candidateBound: false });
    const repair = events.find((event) => event.type === "VerificationRepairStarted");
    expect(repair).toBeDefined();
    expect(repair?.data).toMatchObject({ failureKind: "UNKNOWN_FAILURE" });
    expect(completed?.verificationState).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// Finding C: semantic risk discovery â€” risk rises from diff evidence, not filenames
// ---------------------------------------------------------------------------

describe("semantic risk discovery", () => {
  const patch = (file: string, ...added: string[]): string =>
    [
      `diff --git a/${file} b/${file}`,
      "--- a/" + file,
      "+++ b/" + file,
      "@@ -1,2 +1,3 @@",
      ...added.map((line) => `+${line}`),
    ].join("\n");

  it("hidden-input handling in a neutrally named file is flagged and raises SecuritySensitivity (case 4)", () => {
    const neutral = patch(
      "click/termui.py",
      "def _prompt():",
      "    value = getpass('confirm: ')",
      "    raise ValueError(f'invalid input: {value}')",
    );
    const semantic = deriveSemanticSensitivity(neutral);
    expect(semantic.signals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
    // Risk(t) rises: pre-execution the path-only estimate is LOW, the diff evidence raises it.
    const ownership = { "click/termui.py": "click.termui" };
    const pre = deriveRiskVector({
      files: ["click/termui.py"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
    });
    const post = deriveRiskVector({
      files: ["click/termui.py"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
      diffPatch: neutral,
    });
    expect(pre.SecuritySensitivity.level).toBe("LOW");
    expect(post.SecuritySensitivity.level).toBe("HIGH");
    expect(post.SecuritySensitivity.provenance).toBe("DETERMINISTIC");
  });

  it("credential-shaped values in neutrally named code raise risk (adversarial: neutral names)", () => {
    const neutral = patch(
      "src/lib/handler.ts",
      "const apiToken = await prompt('token');",
      "console.log('using ' + apiToken);",
    );
    const semantic = deriveSemanticSensitivity(neutral);
    expect(semantic.signals).toContain("CREDENTIAL_FLOW");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
  });

  it("test and fixture paths are excluded â€” semantic evidence comes from production code only", () => {
    const testPatch = patch(
      "tests/termui.test.ts",
      "const secretValue = getpass('x');",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional non-template string
      "throw new Error(`bad ${secretValue}`);",
    );
    expect(deriveSemanticSensitivity(testPatch).signals).toHaveLength(0);
  });

  it("prose artifacts carry no semantic signal â€” a markdown report naming credentials is not a code flow", () => {
    // Found the hard way: the fixture agent's own output report names the credential references
    // it was handed; mentioning them in prose is not executing a credential flow.
    const report = patch(
      "agent-output.md",
      "# Native agent fixture output",
      "Credential reference values: none",
      "Managed provider secret visible: not-probed",
    );
    expect(deriveSemanticSensitivity(report).signals).toHaveLength(0);
    expect(deriveSemanticSensitivity(report).exposurePairs).toHaveLength(0);
  });

  it("harmless type declarations and booleans do not escalate security (precision, repair-pass)", () => {
    const benign = patch(
      "src/types.ts",
      "export type Token = string;",
      "export interface Settings {",
      "  hidden: boolean;",
      "  is_admin: boolean;",
      "}",
      "export function encrypt() { return null; }",
    );
    const semantic = deriveSemanticSensitivity(benign);
    expect(semantic.signals).toHaveLength(0);
    expect(semantic.exposurePairs).toHaveLength(0);
  });

  it("prose inside string literals does not fire signals (repair-pass precision)", () => {
    const prose = patch(
      "src/ui/help.ts",
      'const message = "please encrypt your private key and keep the password secret";',
      "export const render = (): string => message;",
    );
    expect(deriveSemanticSensitivity(prose).signals).toHaveLength(0);
  });

  it("hide_input kwarg on a generic prompt API is a hidden-input source, with stderr as a sink", () => {
    const clickStyle = patch(
      "src/lib/cli-flow.py",
      "value = click.prompt('confirm', hide_input=True)",
      "sys.stderr.write(f'bad input: {value}')",
    );
    const semantic = deriveSemanticSensitivity(clickStyle);
    expect(semantic.signals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
  });

  it("getpass aliases (pwinput) and non-console sink paths are recognized", () => {
    const alias = patch(
      "src/lib/reader.py",
      "pin = pwinput()",
      "raise RuntimeError(f'invalid: {pin}')",
    );
    const semantic = deriveSemanticSensitivity(alias);
    expect(semantic.signals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
  });

  it("is_admin in a decision context IS an auth decision; as a bare assignment it is not", () => {
    const decision = patch("src/api/admin.ts", "if (request.user.is_admin) {", "  grant();", "}");
    expect(deriveSemanticSensitivity(decision).signals).toContain("AUTH_DECISION");
    const dataOnly = patch("src/api/types.ts", "user.is_admin = false;");
    expect(deriveSemanticSensitivity(dataOnly).signals).not.toContain("AUTH_DECISION");
  });

  it("extensionless scripts are scannable when they carry a shebang; scripts/ is not blanket-excluded", () => {
    const executable = patch(
      "run-migrate",
      "#!/usr/bin/env python3",
      "value = getpass('db password:')",
      "raise Exception(f'failed: {value}')",
    );
    const semantic = deriveSemanticSensitivity(executable);
    expect(semantic.signals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
    const scriptDir = patch(
      "scripts/rotate_keys.ts",
      "const accessToken = await prompt('');",
      "console.error(`refresh ${accessToken}`);",
    );
    const dirSignals = deriveSemanticSensitivity(scriptDir);
    expect(dirSignals.signals).toContain("CREDENTIAL_FLOW");
    expect(dirSignals.exposurePairs.length).toBeGreaterThan(0);
  });

  it("documentation stays unscanned even with sensitive-sounding code snippets inside", () => {
    const doc = patch("docs/DEPLOYMENT.md", "value = getpass('secret')", "print(value)");
    expect(deriveSemanticSensitivity(doc).signals).toHaveLength(0);
  });

  it("a genuinely low-risk local change stays LOW with no semantic signals (case 7, lightweight)", () => {
    const simple = patch(
      "src/utils/format.ts",
      "export const formatLabel = (s: string): string => s.trim();",
    );
    const semantic = deriveSemanticSensitivity(simple);
    expect(semantic.signals).toHaveLength(0);
    expect(semantic.exposurePairs).toHaveLength(0);
    const ownership = { "src/utils/format.ts": "utils.format" };
    const vector = deriveRiskVector({
      files: ["src/utils/format.ts"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
      diffPatch: simple,
    });
    expect(vector.SecuritySensitivity.level).toBe("LOW");
    const plan = buildAssurancePlan(vector, "FAST");
    expect(plan.required).not.toContain("SECURITY");
    expect(plan.required).not.toContain("PERFORMANCE");
    expect(plan.required).not.toContain("RESILIENCE");
  });

  it("initial LOW risk is raised by later diff evidence â€” Risk(t) is dynamic (case 5)", () => {
    const ownership = { "src/ui/panel.ts": "ui.panel" };
    const pre = deriveRiskVector({
      files: ["src/ui/panel.ts"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
    });
    const evolved = patch(
      "src/ui/panel.ts",
      "const sessionSecret = prompt('secret');",
      "log.info('reloaded ' + sessionSecret);",
    );
    const post = deriveRiskVector({
      files: ["src/ui/panel.ts"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
      diffPatch: evolved,
    });
    expect(pre.SecuritySensitivity.level).toBe("LOW");
    expect(post.SecuritySensitivity.level).toBe("HIGH");
    // The assurance plan follows the risk: SECURITY becomes required only once evidence exists.
    expect(buildAssurancePlan(pre, "FAST").required).not.toContain("SECURITY");
    expect(buildAssurancePlan(post, "FAST").required).toContain("SECURITY");
  });
});

// ---------------------------------------------------------------------------
// Finding D: absence of signal is not evidence of irrelevance; UNKNOWN never becomes PASS
// ---------------------------------------------------------------------------

describe("uncertainty-preserving trust semantics", () => {
  const planNotRequiringSecurity = (): ReturnType<typeof buildAssurancePlan> => {
    const ownership = { "src/ui/panel.ts": "ui.panel" };
    const vector = deriveRiskVector({
      files: ["src/ui/panel.ts"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
    });
    return buildAssurancePlan(vector, "FAST");
  };

  const reportFor = (patch: string) =>
    deriveQualityReport({
      verificationState: "VERIFIED",
      verificationCommand: "true",
      verificationExitCode: 0,
      assurancePlan: planNotRequiringSecurity(),
      preExecutionRisk: deriveRiskVector({
        files: ["src/ui/panel.ts"],
        moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
        packageOwnership: { "src/ui/panel.ts": "ui.panel" },
        crossModuleEdgeCount: 0,
      }),
      diffRisk: deriveRiskVector({
        files: ["src/ui/panel.ts"],
        moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
        packageOwnership: { "src/ui/panel.ts": "ui.panel" },
        crossModuleEdgeCount: 0,
        diffPatch: patch,
      }),
      changedFiles: ["src/ui/panel.ts"],
      initialModules: ["ui.panel"],
      moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
      diffPatch: patch,
    });

  const patchOf = (...added: string[]): string =>
    [
      "diff --git a/src/ui/panel.ts b/src/ui/panel.ts",
      "--- a/src/ui/panel.ts",
      "+++ b/src/ui/panel.ts",
      "@@ -1,1 +1,3 @@",
      ...added.map((l) => `+${l}`),
    ].join("\n");

  it("semantic evidence under a not-required plan yields UNKNOWN Security, blocking MERGE_ELIGIBLE (case 6/8)", () => {
    const patch = patchOf("const hiddenValue = getpass('confirm');", "print(f'got {hiddenValue}')");
    const report = reportFor(patch);
    expect(report.Security.state).toBe("UNKNOWN");
    const plan = planNotRequiringSecurity();
    // The broad UNKNOWN projection is not authoritative; the diff context raises and resolves the
    // exact typed flow obligation, which keeps MERGE_ELIGIBLE unreachable.
    const trust = deriveTrustState("VERIFIED", report, plan, undefined, {
      diffPatch: patch,
      qualityPreference: "BALANCED",
    });
    expect(trust).toBe("CORRECTNESS_VERIFIED");
  });

  it("zero-signal diffs still reach MERGE_ELIGIBLE with NOT_REQUIRED Security (case 7 â€” adaptive, not paranoid)", () => {
    const report = reportFor(patchOf("export const label = (s: string): string => s.trim();"));
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(report.Security.evidence.join(" ")).toMatch(/absence of signal/iu);
    const trust = deriveTrustState("VERIFIED", report, planNotRequiringSecurity(), undefined);
    expect(trust).toBe("MERGE_ELIGIBLE");
  });

  it("semantic evidence under a REQUIRED security plan yields WARN, not a blind PASS (repair-pass)", () => {
    // The independent audit's core flaw: the diff made SECURITY required via semantic evidence,
    // then an unrelated generic credential-leak scan PASS "satisfied" it. It must not.
    const patchText = patchOf(
      "const value = getpass('confirm');",
      "throw new Error(`invalid: ${value}`);",
    );
    const diffRisk = deriveRiskVector({
      files: ["src/ui/panel.ts"],
      moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
      packageOwnership: { "src/ui/panel.ts": "ui.panel" },
      crossModuleEdgeCount: 0,
      diffPatch: patchText,
    });
    expect(diffRisk.SecuritySensitivity.level).toBe("HIGH");
    const requiredPlan = buildAssurancePlan(diffRisk, "FAST");
    expect(requiredPlan.required).toContain("SECURITY");
    const report = deriveQualityReport({
      verificationState: "VERIFIED",
      verificationCommand: "true",
      verificationExitCode: 0,
      assurancePlan: requiredPlan,
      preExecutionRisk: deriveRiskVector({
        files: ["src/ui/panel.ts"],
        moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
        packageOwnership: { "src/ui/panel.ts": "ui.panel" },
        crossModuleEdgeCount: 0,
      }),
      diffRisk,
      changedFiles: ["src/ui/panel.ts"],
      initialModules: ["ui.panel"],
      moduleOwnership: { "src/ui/panel.ts": "ui.panel" },
      diffPatch: patchText,
    });
    expect(report.Security.state).toBe("WARN");
    expect(report.Security.evidence.join(" ")).toMatch(/does not resolve|not.*address|semantic/iu);
    expect(deriveTrustState("VERIFIED", report, requiredPlan, undefined)).not.toBe(
      "MERGE_ELIGIBLE",
    );
  });
});

// ---------------------------------------------------------------------------
// Repair pass: the LIVE RunService sequence — pre-execution risk, candidate, diff-captured
// Risk(t), rebuilt AssurancePlan, verification, quality, emitted trust state
// ---------------------------------------------------------------------------

describe("live RunService sequence emits the security-gated trust state (repair-pass)", () => {
  const alwaysOk: VerifierPort = {
    async verify(run: Run): Promise<Verification> {
      return {
        id: crypto.randomUUID(),
        runId: run.id,
        type: "command",
        state: "VERIFIED",
        exitCode: 0,
        output: "ok",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
    async cancel(): Promise<void> {},
  };

  it("hidden-input handling in a neutral file: verified but NOT merge-eligible, end to end", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(alwaysOk);
    const created = await service.create({
      prompt: "handle hidden input in the confirm flow",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    // The final EMITTED trust state — through the real diff capture, Risk(t), rebuilt plan,
    // verification, and quality assessment — must reflect the semantic security uncertainty.
    expect(completed?.verificationState).toBe("VERIFIED");
    expect(completed?.trustState).not.toBe("MERGE_ELIGIBLE");
    const events = await service.events(created.id);
    const quality = events.find((event) => event.type === "QualityAssessed");
    expect(quality?.data).toMatchObject({
      report: expect.objectContaining({ Security: expect.anything() }),
    });
    expect(JSON.stringify(quality?.data)).toMatch(/HIDDEN_INPUT|possible exposure/u);
  });

  it("benign change: the same live path still reaches MERGE_ELIGIBLE (adaptive, not paranoid)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(alwaysOk);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState).toBe("VERIFIED");
    expect(completed?.trustState).toBe("MERGE_ELIGIBLE");
  });
});

// ---------------------------------------------------------------------------
// Hardening pass #3, Part A: structured verifier execution evidence — attribution from the
// shell boundary, not prose regexes
// ---------------------------------------------------------------------------

/** Byte-accurate reproduction of a live Windows PowerShell run of a missing verifier executable. */
const POWERSHELL_COMMAND_NOT_FOUND = [
  "maf-missing-verifier-9f3 : The term 'maf-missing-verifier-9f3' is not recognized as the name of",
  "a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a",
  "path was included, verify that the path is correct and try again.",
  "At line:1 char:1",
  "+ maf-missing-verifier-9f3 --version",
  "+ ~~~~~~~~~~~~~~~~~~~~~~~~~",
  "    + CategoryInfo          : ObjectNotFound: (maf-missing-verifier-9f3:String) [], CommandNotF",
  "   oundException",
  "    + FullyQualifiedErrorId : CommandNotFoundException",
].join("\n");

describe("structured verifier execution evidence (pass #3, Part A)", () => {
  it("COMMAND_NOT_FOUND execution evidence attributes ENVIRONMENT_FAILURE even with unmatched prose (case A)", () => {
    // PowerShell's CommandNotFoundException exits 1 with prose no generic pattern matched before
    // pass #3 — structured evidence from the shell boundary is authoritative regardless of text.
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: POWERSHELL_COMMAND_NOT_FOUND,
      execution: { shellSpawned: true, commandResolution: "COMMAND_NOT_FOUND" },
    });
    expect(attribution.kind).toBe("ENVIRONMENT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
    expect(attribution.evidence[0]).toMatch(/structured execution evidence/u);
  });

  it("SHELL_UNAVAILABLE execution evidence attributes ENVIRONMENT_FAILURE — the shell never started", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: 'verifier shell "powershell" could not be spawned',
      execution: { shellSpawned: false, commandResolution: "SHELL_UNAVAILABLE" },
    });
    expect(attribution.kind).toBe("ENVIRONMENT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("a REAL missing verifier executable on this machine: exit 1, QUARANTINED, COMMAND_NOT_FOUND evidence (case A)", async () => {
    // The real CommandVerifier through the real shell. On Windows this is exactly the audited
    // reproduction: PowerShell resolves the name, fails with CommandNotFoundException, exits 1.
    const verifier = new CommandVerifier();
    const verification = await verifier.verify(
      { id: "run-verifier-probe" } as unknown as Run,
      {
        verification: { command: "maf-missing-verifier-9f3 --version" },
      } as unknown as Task,
      { path: process.cwd() } as unknown as Sandbox,
      { changedFiles: [] } as unknown as SandboxDiff,
    );
    expect(verification.state).toBe("QUARANTINED");
    expect(verification.execution).toMatchObject({
      shellSpawned: true,
      commandResolution: "COMMAND_NOT_FOUND",
      // The boundary also records HOW the process ended (hardening pass #4): the shell itself ran
      // to completion here — it was the command NAME inside it that did not resolve.
      termination: "COMPLETED",
    });
    // Feeding that structured evidence back through attribution stays environment-bound.
    const attribution = attributeVerificationFailure({
      exitCode: verification.exitCode,
      output: verification.output,
      execution: verification.execution,
    });
    expect(attribution.kind).toBe("ENVIRONMENT_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("missing package.json (npm ERR! enoent) is ambiguous UNKNOWN, never DEPENDENCY_FAILURE (case B)", () => {
    // The candidate may have failed to produce it; a dependency-conflict attribution would starve
    // candidate repair exactly the way the audit described.
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: [
        "npm ERR! code ENOENT",
        "npm ERR! syscall open",
        "npm ERR! path C:\\repo\\package.json",
        "npm ERR! errno -4058",
        "npm ERR! enoent ENOENT: no such file or directory, open 'C:\\repo\\package.json'",
      ].join("\n"),
    });
    expect(attribution.kind).toBe("UNKNOWN_FAILURE");
    expect(attribution.candidateBound).toBe(false);
  });

  it("live: real PowerShell missing-verifier evidence fails closed with no candidate repair (case A, integration)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    // Structured execution evidence persists across the bounded retry: the toolchain is broken.
    const { service } = harness(
      new ScriptedVerifier([
        {
          exitCode: 1,
          output: POWERSHELL_COMMAND_NOT_FOUND,
          execution: { shellSpawned: true, commandResolution: "COMMAND_NOT_FOUND" },
        },
        {
          exitCode: 1,
          output: POWERSHELL_COMMAND_NOT_FOUND,
          execution: { shellSpawned: true, commandResolution: "COMMAND_NOT_FOUND" },
        },
      ]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { command: "maf-missing-verifier-9f3 --version" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "VerificationRepairStarted")).toBe(false);
    const attributed = events.find((event) => event.type === "VerificationFailureAttributed");
    expect(attributed?.data).toMatchObject({ kind: "ENVIRONMENT_FAILURE", candidateBound: false });
    expect(completed?.verificationState).toBe("QUARANTINED");
    expect(completed?.trustState).not.toBe("MERGE_ELIGIBLE");
  });

  it("live: missing-verifier evidence recovers via bounded retry alone once the toolchain works (case A, integration)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(
      new ScriptedVerifier([
        {
          exitCode: 1,
          output: POWERSHELL_COMMAND_NOT_FOUND,
          execution: { shellSpawned: true, commandResolution: "COMMAND_NOT_FOUND" },
        },
        { exitCode: 0, output: "ok" },
      ]),
    );
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    const events = await service.events(created.id);
    expect(events.some((event) => event.type === "VerificationRepairStarted")).toBe(false);
    expect(events.some((event) => event.type === "VerificationEnvironmentRetried")).toBe(true);
    expect(completed?.verificationState).toBe("VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// Hardening pass #3, Parts C/D/E: bounded structural analysis, signal strength, inert vs
// behavioral content — NEW adversarial cases, not the audit's literals
// ---------------------------------------------------------------------------

describe("semantic signal strength and bounded structural analysis (pass #3, Parts C/D/E)", () => {
  const patch = (file: string, ...added: string[]): string =>
    [
      `diff --git a/${file} b/${file}`,
      "--- a/" + file,
      "+++ b/" + file,
      "@@ -1,2 +1,4 @@",
      ...added.map((line) => `+${line}`),
    ].join("\n");

  it("concealment kwarg on a PREVIOUSLY UNSEEN API is a structural hidden-input source (case C)", () => {
    const unseen = patch(
      "src/lib/entry.py",
      'value = prompt_for("api key", conceal=True)',
      'sys.stderr.write(f"validation failed: {value}")',
    );
    const semantic = deriveSemanticSensitivity(unseen);
    expect(semantic.signals).toContain("HIDDEN_INPUT");
    expect(semantic.structuralSignals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
  });

  it("import-alias indirection resolves to the sensitive API it actually is (case E)", () => {
    const aliased = patch(
      "src/lib/confirm.py",
      "from getpass import getpass as ask_confirmation",
      "pin = ask_confirmation('pin: ')",
      "raise RuntimeError(f'bad pin: {pin}')",
    );
    const semantic = deriveSemanticSensitivity(aliased);
    expect(semantic.structuralSignals).toContain("HIDDEN_INPUT");
    expect(semantic.exposurePairs.length).toBeGreaterThan(0);
  });

  it("source -> temp variable -> sink is caught by bounded one-hop propagation (case D)", () => {
    const laundered = patch(
      "src/domain/confirm.ts",
      'const secret = getpass("k");',
      "const interim = secret;",
      "console.log(`value ${interim}`);",
    );
    const semantic = deriveSemanticSensitivity(laundered);
    expect(semantic.exposurePairs).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "interim" })]),
    );
  });

  it("security-adjacent vocabulary with no code shape stays LEXICAL and never escalates (case F)", () => {
    const vocabularyOnly = patch(
      "src/utils/labels.ts",
      "export const tokenizer = (s: string): string[] => s.split(/\\s+/);",
      "export const private_key_noun = 1;",
    );
    const semantic = deriveSemanticSensitivity(vocabularyOnly);
    expect(semantic.structuralSignals).toHaveLength(0);
    expect(semantic.exposurePairs).toHaveLength(0);
    const ownership = { "src/utils/labels.ts": "utils.labels" };
    const vector = deriveRiskVector({
      files: ["src/utils/labels.ts"],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
      diffPatch: vocabularyOnly,
    });
    expect(vector.SecuritySensitivity.level).toBe("LOW");
    expect(buildAssurancePlan(vector, "FAST").required).not.toContain("SECURITY");
  });

  it("workflow YAML adding command/step definitions is behavioral-unsupported, not inert (case G)", () => {
    const workflow = patch(
      ".github/workflows/deploy.yml",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: curl -fsSL https://internal.example.invalid/install | sh",
    );
    const semantic = deriveSemanticSensitivity(workflow);
    expect(semantic.behavioralUnsupportedFiles).toContain(".github/workflows/deploy.yml");
    expect(semantic.signals).toHaveLength(0);
  });

  it("a pure prose/config YAML change with no behavioral line stays inert (precision)", () => {
    const inert = patch("config/defaults.yml", "version: 2", "description: no commands here");
    const semantic = deriveSemanticSensitivity(inert);
    expect(semantic.behavioralUnsupportedFiles).toHaveLength(0);
    expect(semantic.signals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hardening pass #3, Parts B/F: evidence-typed security posture and the trust decision
// ---------------------------------------------------------------------------

describe("evidence-typed security posture and trust (pass #3, Parts B/F, cases Fâ€“J)", () => {
  const patch = (file: string, ...added: string[]): string =>
    [
      `diff --git a/${file} b/${file}`,
      "--- a/" + file,
      "+++ b/" + file,
      "@@ -1,2 +1,3 @@",
      ...added.map((line) => `+${line}`),
    ].join("\n");

  const reportFor = (patchText: string, file: string, requiredSecurity = false) => {
    const ownership = { [file]: "app.feature" };
    const vector = deriveRiskVector({
      files: [file],
      moduleOwnership: ownership,
      packageOwnership: ownership,
      crossModuleEdgeCount: 0,
      diffPatch: patchText,
    });
    const plan = requiredSecurity
      ? buildAssurancePlan(vector, "CRITICAL")
      : buildAssurancePlan(vector, "FAST");
    return {
      report: deriveQualityReport({
        verificationState: "VERIFIED",
        verificationCommand: "true",
        verificationExitCode: 0,
        assurancePlan: plan,
        preExecutionRisk: deriveRiskVector({
          files: [file],
          moduleOwnership: ownership,
          packageOwnership: ownership,
          crossModuleEdgeCount: 0,
        }),
        diffRisk: vector,
        changedFiles: [file],
        initialModules: ["app.feature"],
        moduleOwnership: ownership,
        diffPatch: patchText,
      }),
      plan,
    };
  };

  it("production credential-literal posture WARN is productionFlagged and can never become NOT_REQUIRED (case I)", () => {
    const leak = patch("src/config/settings.ts", 'const deployApiKey = "ak-live-9f3d2c81b7e4";');
    const posture = deriveSecurityPosture(leak);
    expect(posture.state).toBe("WARN");
    expect(posture.productionFlagged).toBe(true);
    // Not plan-required: WARN must not collapse to NOT_REQUIRED — it becomes UNKNOWN, which gates.
    const { report, plan } = reportFor(leak, "src/config/settings.ts");
    expect(plan.required).not.toContain("SECURITY");
    expect(report.Security.state).toBe("UNKNOWN");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).not.toBe("MERGE_ELIGIBLE");
  });

  it("test-confined dummy credentials stay fixture-normal: plan-bound, not a hard gate (case I counterpart)", () => {
    // A structured (real-shaped) dummy in a TEST file → WARN, but NOT productionFlagged: the
    // documented fixture-normal resolution keeps it plan-bound instead of a hard gate.
    const dummy = patch(
      "tests/settings.test.ts",
      'const deployToken = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";',
    );
    const posture = deriveSecurityPosture(dummy);
    expect(posture.state).toBe("WARN");
    expect(posture.productionFlagged).toBe(false);
    const { report, plan } = reportFor(dummy, "tests/settings.test.ts");
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("MERGE_ELIGIBLE");
  });

  it("behavioral-unsupported workflow content yields UNKNOWN/NOT_CHECKED Security, never NOT_REQUIRED (case G)", () => {
    const workflow = patch(
      ".github/workflows/deploy.yml",
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - run: curl -fsSL https://internal.example.invalid/install | sh",
    );
    const { report, plan } = reportFor(workflow, ".github/workflows/deploy.yml");
    expect(plan.required).not.toContain("SECURITY");
    expect(report.Security.state).toBe("UNKNOWN");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).not.toBe("MERGE_ELIGIBLE");
  });

  it("inert markdown/fixtures stay NOT_REQUIRED and merge-eligible — no unnecessary assurance (case H)", () => {
    const doc = patch("docs/NOTES.md", "value = getpass('x')", "print(value)");
    const { report, plan } = reportFor(doc, "docs/NOTES.md");
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("MERGE_ELIGIBLE");
  });

  it("lexical-only sensitivity stays NOT_REQUIRED with disclosure — no false block (case F)", () => {
    const vocabularyOnly = patch(
      "src/utils/labels.ts",
      "export const private_key_noun = 1;",
      "export const note = 'handles secret material';",
    );
    const { report, plan } = reportFor(vocabularyOnly, "src/utils/labels.ts");
    expect(report.Security.state).toBe("NOT_REQUIRED");
    expect(report.Security.evidence.join(" ")).toMatch(/lexical|absence of signal/u);
    expect(deriveTrustState("VERIFIED", report, plan, undefined)).toBe("MERGE_ELIGIBLE");
  });

  it("live: unseen aliased concealed-input API routed to a sink blocks MERGE_ELIGIBLE end to end (cases C/D/J)", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const alwaysOk: VerifierPort = {
      async verify(run: Run): Promise<Verification> {
        return {
          id: crypto.randomUUID(),
          runId: run.id,
          type: "command",
          state: "VERIFIED",
          exitCode: 0,
          output: "ok",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      },
      async cancel(): Promise<void> {},
    };
    const { service } = harness(alwaysOk);
    const created = await service.create({
      prompt: "route concealed credential through the reader flow",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    // The full live path (diff capture, Risk(t), rebuilt plan, verification, quality) must not
    // hand back MERGE_ELIGIBLE from unresolved material security evidence.
    expect(completed?.verificationState).toBe("VERIFIED");
    expect(completed?.trustState).not.toBe("MERGE_ELIGIBLE");
    const events = await service.events(created.id);
    const quality = events.find((event) => event.type === "QualityAssessed");
    const security = JSON.stringify(quality?.data);
    expect(security).toMatch(/HIDDEN_INPUT|possible exposure|UNKNOWN/u);
  });
});
