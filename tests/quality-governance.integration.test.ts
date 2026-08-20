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
    // Debt honestly stays UNKNOWN pending the M7 checker.
    expect(data.report.DebtDelta.state).toBe("UNKNOWN");
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
    // SECURITY is plan-required but has no checker until M8: honestly UNKNOWN, never PASS.
    expect(data.report.Security.state).toBe("UNKNOWN");
    expect(data.report.Security.provenance).toBe("PENDING_CHECKER");
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
