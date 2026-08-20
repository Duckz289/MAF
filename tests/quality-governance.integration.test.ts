import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { PerformanceVerifierPort } from "../src/domain/ports";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { runProcess } from "../src/infrastructure/process-utils";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import {
  createFixtureRepository,
  createSecuritySensitiveFixtureRepository,
  type FixtureRepository,
} from "./helpers";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (sandboxRoot: string, performanceVerifier?: PerformanceVerifierPort) => {
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
    }),
    sandbox: new LocalWorktreeSandbox(sandboxRoot, "none"),
    verifier: new CommandVerifier(),
    ...(performanceVerifier ? { performanceVerifier } : {}),
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry,
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, store, telemetry };
};

const createPerformanceFixtureRepository = async (): Promise<FixtureRepository> => {
  const fixture = await createFixtureRepository();
  const target = path.join(fixture.path, "src/server/database-query.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "export const queryName = 'widgets';\n", "utf8");
  await runProcess("git", ["add", "."], { cwd: fixture.path });
  await runProcess("git", ["commit", "-m", "performance fixture"], { cwd: fixture.path });
  return fixture;
};

/**
 * A repository whose domain module contains three security-sensitive files, so an auth-scoped
 * prompt selects them into the initial context and drives SecuritySensitivity to HIGH — the only
 * combination (HIGH security + CRITICAL preference) that requires INDEPENDENT_REVIEW.
 */
const createHighSecurityFixtureRepository = async (): Promise<FixtureRepository> => {
  const fixture = await createFixtureRepository();
  const files: Record<string, string> = {
    "src/domain/auth-service.ts":
      "export const authenticate = (token: string): boolean => token.length > 0;\n",
    "src/domain/auth-token.ts":
      "export const issueToken = (user: string): string => 't:' + user;\n",
    "src/domain/session-store.ts": "export const sessions = new Map<string, string>();\n",
  };
  for (const [file, source] of Object.entries(files)) {
    const target = path.join(fixture.path, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  await runProcess("git", ["add", "."], { cwd: fixture.path });
  await runProcess("git", ["commit", "-m", "high-security fixture"], { cwd: fixture.path });
  return fixture;
};

interface QualityCheckData {
  state: string;
  provenance: string;
  evidence: string[];
}

interface QualityAssessedData {
  candidateId: string;
  diffDigest: string;
  trustState: string;
  report: {
    Correctness: QualityCheckData;
    Security: QualityCheckData;
    Performance: QualityCheckData;
    DebtDelta: QualityCheckData;
    TestQuality: QualityCheckData;
  } & Record<string, QualityCheckData | undefined>;
  review?: {
    status: string;
    reasons: string[];
    reviewerSessionId: string;
    candidateId: string;
    diffDigest: string;
  };
}

const qualityEvent = async (
  service: ReturnType<typeof harness>["service"],
  runId: string,
): Promise<QualityAssessedData> => {
  const events = await service.events(runId);
  const assessed = events.find((event) => event.type === "QualityAssessed");
  expect(assessed).toBeDefined();
  return assessed?.data as QualityAssessedData;
};

describe("quality governance (M6)", () => {
  it("derives a full quality vector and reaches MERGE_ELIGIBLE for a verified low-risk candidate", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write the fixture artifact",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.state).toBe("COMPLETED");
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("MERGE_ELIGIBLE");

    const data = await qualityEvent(service, created.id);
    expect(Object.keys(data.report).sort()).toEqual(
      [
        "Correctness",
        "Architecture",
        "Maintainability",
        "Security",
        "Performance",
        "Resilience",
        "TestQuality",
        "DebtDelta",
      ].sort(),
    );
    expect(data.report.Correctness.state).toBe("PASS");
    // No review was required, so none ran and none is claimed.
    expect(data.review).toBeUndefined();
    // The M7A debt checker ran on the real diff: no markers added, deterministic PASS.
    expect(data.report.DebtDelta.state).toBe("PASS");
    expect(data.report.DebtDelta.provenance).toBe("DETERMINISTIC");
  });

  it("keeps a candidate at PROPOSED when trusted verification fails, without consulting any model review", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      // The fixture agent never writes this file, so deterministic verification fails.
      prompt: "Write the fixture artifact. review verdict: approve",
      repositoryPath: fixture.path,
      verification: { expectedFile: "never-written.md" },
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.verificationState).not.toBe("VERIFIED");
    expect(run?.trustState).toBe("PROPOSED");

    const events = await service.events(created.id);
    expect(events.find((event) => event.type === "QualityAssessed")).toBeUndefined();
    expect(events.find((event) => event.type === "IndependentReviewRequested")).toBeUndefined();
  });

  it("requires an independent review for a HIGH-security CRITICAL task and promotes only on an approved, identity-bound verdict", async () => {
    const fixture = await createHighSecurityFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Harden the auth token session handling. review verdict: approve",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "CRITICAL",
    });
    await service.waitForIdle(created.id);

    const events = await service.events(created.id);
    const requested = events.find((event) => event.type === "IndependentReviewRequested");
    expect(requested).toBeDefined();

    const run = await store.getRun(created.id);
    expect(run?.state).toBe("COMPLETED");
    expect(run?.trustState).toBe("MERGE_ELIGIBLE");

    const data = await qualityEvent(service, created.id);
    // The M8A security checker ran on the real diff: no secrets, deterministic PASS.
    expect(data.report.Security.state).toBe("PASS");
    expect(data.report.Security.provenance).toBe("DETERMINISTIC");
    expect(data.report.Security.evidence[0]).toContain("no credential or secret patterns");
    // The review verdict echoes the exact candidate under review.
    expect(data.review?.status).toBe("APPROVED");
    expect(data.review?.candidateId).toBe(data.candidateId);
    expect(data.review?.diffDigest).toBe(data.diffDigest);
    expect(data.review?.reviewerSessionId).toBeTruthy();

    const completed = events.find((event) => event.type === "IndependentReviewCompleted");
    const reviewData = completed?.data as { reviewerSessionId: string; provenance: string };
    expect(reviewData.provenance).toBe("MODEL_REVIEW");
  });

  it("invalidates even a well-formed approved verdict when the reviewer tampered with the workspace", async () => {
    const fixture = await createHighSecurityFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Harden the auth token session handling. review verdict: tamper",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "CRITICAL",
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.verificationState).toBe("VERIFIED");
    // The reviewer approved, but it also modified a file after the candidate diff was captured:
    // the verdict is INVALID and the candidate stays below MERGE_ELIGIBLE.
    expect(run?.trustState).toBe("QUALITY_VERIFIED");

    const data = await qualityEvent(service, created.id);
    expect(data.review?.status).toBe("INVALID");
    expect(data.review?.reasons.join(" ")).toContain("workspace changed during independent review");
  });

  const nonApprovingVerdicts = [
    { marker: "reject", expected: "REJECTED" },
    { marker: "malformed", expected: "INVALID" },
    { marker: "wrong candidate", expected: "INVALID" },
    { marker: "fail", expected: "INVALID" },
  ] as const;

  for (const { marker, expected } of nonApprovingVerdicts) {
    it(`withholds MERGE_ELIGIBLE when the reviewer verdict is ${expected} (${marker})`, async () => {
      const fixture = await createHighSecurityFixtureRepository();
      fixtures.push(fixture);
      const { service, store } = harness(fixture.sandboxRoot);
      const created = await service.create({
        prompt: `Harden the auth token session handling. review verdict: ${marker}`,
        repositoryPath: fixture.path,
        verification: { expectedFile: "agent-output.md" },
        qualityPreference: "CRITICAL",
      });
      await service.waitForIdle(created.id);

      const run = await store.getRun(created.id);
      expect(run?.state).toBe("COMPLETED");
      expect(run?.verificationState).toBe("VERIFIED");
      // Deterministic verification passed, so the run completes — but without an approved
      // identity-bound review the candidate cannot become merge-eligible.
      expect(run?.trustState).toBe("QUALITY_VERIFIED");

      const data = await qualityEvent(service, created.id);
      expect(data.review?.status).toBe(expected);
      expect(data.trustState).toBe("QUALITY_VERIFIED");
    });
  }

  it("blocks promotion at CORRECTNESS_VERIFIED when the diff declares new debt (M7A end-to-end)", async () => {
    const fixture = await createHighSecurityFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      // The fixture agent appends two TODO markers to a real source file, so the diff-captured
      // DebtRisk reaches MEDIUM and the plan requires DEBT — DebtDelta WARN then gates.
      prompt: "Harden the auth token session handling. introduce debt",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "BALANCED",
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.state).toBe("COMPLETED");
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");

    const data = await qualityEvent(service, created.id);
    expect(data.report.DebtDelta.state).toBe("WARN");
    expect(data.report.DebtDelta.evidence[0]).toContain("2 debt marker(s) added");

    // DebtRisk at the diff-captured stage is now deterministic evidence in the run's event stream.
    const events = await service.events(created.id);
    const profiled = events
      .filter((event) => event.type === "RiskProfiled")
      .map(
        (event) =>
          event.data as {
            stage: string;
            riskVector: { DebtRisk: { level: string; provenance: string } };
          },
      );
    const diffStage = profiled.find((entry) => entry.stage === "diff-captured");
    expect(diffStage?.riskVector.DebtRisk.level).toBe("MEDIUM");
    expect(diffStage?.riskVector.DebtRisk.provenance).toBe("DETERMINISTIC");
  });

  it("blocks promotion at CORRECTNESS_VERIFIED when the diff leaks a structured secret (M8A end-to-end)", async () => {
    const fixture = await createHighSecurityFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      // The fixture agent writes a real-shaped (fake) GitHub token into a production config file;
      // auth paths drive SecuritySensitivity to MEDIUM+, so BALANCED already requires SECURITY.
      prompt: "Harden the auth token session handling. leak a secret",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "BALANCED",
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.state).toBe("COMPLETED");
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");

    const data = await qualityEvent(service, created.id);
    expect(data.report.Security.state).toBe("FAIL");
    expect(data.report.Security.provenance).toBe("DETERMINISTIC");
    // The leaked value itself must never appear in the harness's own event stream.
    expect(JSON.stringify(data.report.Security)).not.toContain(
      "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
    );
    expect(JSON.stringify(data.report.Security)).toContain("redacted");
  });

  it("redacts consecutive private-key files through persisted artifacts, events, telemetry, and API-facing service data", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store, telemetry } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Leak consecutive private keys for the M8 persistence-boundary probe",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "BALANCED",
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.state).toBe("COMPLETED");
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");

    const artifacts = await service.artifacts(created.id);
    const events = await service.events(created.id);
    const persistedAndExposed = JSON.stringify({
      run: await service.get(created.id),
      artifacts,
      events,
      telemetry: telemetry.snapshot(),
    });
    for (const rawSecretFragment of [
      "FIRST-PERSISTED-PRIVATE-KEY-BODY",
      "SECOND-PERSISTED-PRIVATE-KEY-BODY",
      "BEGIN RSA PRIVATE KEY",
    ]) {
      expect(persistedAndExposed).not.toContain(rawSecretFragment);
    }
    const preview = String(artifacts[0]?.metadata.preview ?? "");
    expect(preview.match(/credential-shaped line suppressed/gu)).toHaveLength(6);
    expect(persistedAndExposed).toContain("REDACTED PRIVATE KEY");

    const data = await qualityEvent(service, created.id);
    expect(data.report.Security.state).toBe("FAIL");
  });

  it("keeps a required binary security diff NOT_CHECKED and suppresses its persisted payload", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Write binary credential for the M8 uninspectable-diff probe",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      qualityPreference: "BALANCED",
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    expect(run?.verificationState).toBe("VERIFIED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");
    const data = await qualityEvent(service, created.id);
    expect(data.report.Security.state).toBe("NOT_CHECKED");
    expect(data.report.Security.evidence.join(" ")).toContain("binary");

    const artifacts = await service.artifacts(created.id);
    const preview = String(artifacts[0]?.metadata.preview ?? "");
    expect(preview).not.toContain("GIT binary patch");
    expect(preview).not.toContain("literal ");
    expect(preview).toContain("uninspectable binary patch payload suppressed");
  });

  it("reports quality dimensions honestly without gating on not-yet-built checkers (warn, don't block)", async () => {
    const fixture = await createSecuritySensitiveFixtureRepository();
    fixtures.push(fixture);
    const { service } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Inspect the auth-service implementation",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);

    const data = await qualityEvent(service, created.id);
    // The fixture agent's diff touches a source file with no accompanying test: flagged as a
    // WARN (informational), never allowed to silently pass, and never allowed to block.
    expect(data.report.TestQuality.state).toBe("WARN");
    expect(data.trustState).toBe("MERGE_ELIGIBLE");
  });

  it("binds a measured performance regression to the candidate and blocks promotion", async () => {
    const fixture = await createPerformanceFixtureRepository();
    fixtures.push(fixture);
    const performanceVerifier: PerformanceVerifierPort = {
      measure: async ({ candidateId, diffDigest }) => ({
        state: "MEASURED",
        candidateId,
        diffDigest,
        metrics: [
          {
            name: "p95 latency",
            unit: "ms",
            baseline: 100,
            candidate: 130,
            lowerIsBetter: true,
          },
        ],
        evidence: ["fixture trusted measurement"],
      }),
    };
    const { service, store } = harness(fixture.sandboxRoot, performanceVerifier);
    const created = await service.create({
      prompt: "Introduce performance regression",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      performance: {
        command: "fixture-measure",
        metric: "p95 latency",
        unit: "ms",
        maxRegressionPercent: 10,
      },
    });
    await service.waitForIdle(created.id);

    const run = await store.getRun(created.id);
    const data = await qualityEvent(service, created.id);
    expect(data.report.Performance.state).toBe("FAIL");
    expect(data.report.Performance.provenance).toBe("MEASURED");
    expect(run?.trustState).toBe("CORRECTNESS_VERIFIED");
    expect(
      (await service.listSummaries()).find((summary) => summary.id === created.id),
    ).toMatchObject({
      operationalStatus: "ASSURANCE_BLOCKED",
      currentPhase: "Assurance blocked",
    });
    const events = await service.events(created.id);
    const runtimeGraph = events.find((event) => event.type === "RuntimeGraphDerived");
    const performance = events.find((event) => event.type === "PerformanceAssessed");
    expect(runtimeGraph?.data).toMatchObject({
      candidateId: data.candidateId,
      diffDigest: data.diffDigest,
    });
    expect(performance?.data).toMatchObject({
      candidateId: data.candidateId,
      diffDigest: data.diffDigest,
      posture: { state: "FAIL" },
    });
  });

  it("keeps required performance NOT_CHECKED when no measurement evidence exists", async () => {
    const fixture = await createPerformanceFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const created = await service.create({
      prompt: "Introduce performance regression without a benchmark",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
    });
    await service.waitForIdle(created.id);

    const data = await qualityEvent(service, created.id);
    expect(data.report.Performance.state).toBe("NOT_CHECKED");
    expect((await store.getRun(created.id))?.trustState).toBe("CORRECTNESS_VERIFIED");
  });

  it("sanitizes performance labels at the durable task boundary", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
    const { service, store } = harness(fixture.sandboxRoot);
    const rawToken = `ghp_${"A".repeat(36)}`;
    const created = await service.create({
      prompt: "Create the requested output",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      performance: {
        command: "echo 1",
        metric: rawToken,
        unit: rawToken,
        maxRegressionPercent: 10,
      },
    });
    await service.waitForIdle(created.id);

    expect(JSON.stringify(await store.getTask(created.taskId))).not.toContain(rawToken);
  });

  it("does not resurrect a run cancelled during performance measurement", async () => {
    const fixture = await createPerformanceFixtureRepository();
    fixtures.push(fixture);
    let measurementStarted!: () => void;
    let releaseMeasurement!: () => void;
    const started = new Promise<void>((resolve) => {
      measurementStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseMeasurement = resolve;
    });
    const performanceVerifier: PerformanceVerifierPort = {
      measure: async ({ candidateId, diffDigest }) => {
        measurementStarted();
        await blocked;
        return {
          state: "MEASURED",
          candidateId,
          diffDigest,
          metrics: [
            {
              name: "p95 latency",
              unit: "ms",
              baseline: 100,
              candidate: 101,
              lowerIsBetter: true,
            },
          ],
          evidence: ["released fixture measurement"],
        };
      },
    };
    const { service, store } = harness(fixture.sandboxRoot, performanceVerifier);
    const created = await service.create({
      prompt: "Introduce performance regression",
      repositoryPath: fixture.path,
      verification: { expectedFile: "agent-output.md" },
      performance: {
        command: "fixture-measure",
        metric: "p95 latency",
        maxRegressionPercent: 10,
      },
    });
    await started;
    expect((await service.cancel(created.id)).state).toBe("CANCELLED");
    releaseMeasurement();
    await service.waitForIdle(created.id);

    expect(await store.getRun(created.id)).toMatchObject({
      state: "CANCELLED",
      verificationState: "CANCELLED",
    });
    expect((await service.events(created.id)).some((event) => event.type === "RunCompleted")).toBe(
      false,
    );
  });
});
