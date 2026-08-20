import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { CommandVerifier } from "../src/infrastructure/verifier";
import {
  createFixtureRepository,
  createSecuritySensitiveFixtureRepository,
  type FixtureRepository,
} from "./helpers";
import { runProcess } from "../src/infrastructure/process-utils";

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const harness = (sandboxRoot: string) => {
  const store = new InMemoryRunStore();
  const brain = new InMemoryProjectBrain();
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
    repositoryIndex: new LocalRepositoryIndex(),
    projectBrain: brain,
    contextBuilder: new GuidedContextBuilder(brain),
    telemetry: new DomainTelemetryRecorder(),
    runtimeSignals: new EvidenceRuntimeSignalCollector(),
  });
  return { service, store };
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
});
