import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectCapabilityConcerns } from "../src/application/capability-execution";
import { buildAssurancePlan } from "../src/domain/assurance";
import { unresolvedObligations } from "../src/domain/assurance-obligation";
import {
  assuranceObligationsFor,
  deriveQualityReport,
  deriveTrustState,
} from "../src/domain/quality";
import { deriveRiskVector } from "../src/domain/risk";
import { MissionTree, type MissionNode } from "../src/domain/mission-tree";
import type { Sandbox, SandboxDiff } from "../src/domain/ports";
import type { Run, Task } from "../src/domain/types";
import { normalizeVerificationSpecification } from "../src/domain/verification-spec";
import { materializeVerificationCandidate } from "../src/infrastructure/verification-materialization";
import { CommandVerifier } from "../src/infrastructure/verifier";

const digestManifest = (
  entries: Array<{ path: string; mode: "100644" | "100755" | "120000"; digest: string }>,
): string => {
  const hash = createHash("sha256");
  for (const entry of entries.toSorted((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${entry.path}\0${entry.mode}\0${entry.digest}\0`);
  }
  return hash.digest("hex");
};

const run = {
  id: "run-session-11-6",
  taskId: "task-session-11-6",
  state: "RUNNING",
  executionMode: "GUIDED",
  desiredMode: "GUIDED",
  effectiveMode: "GUIDED",
  verificationState: "VERIFYING",
  agent: "fixture",
  model: "fixture",
  provider: "fixture",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  changedFiles: [],
  cost: { model: 0, sandbox: 0, verification: 0, retry: 0, recovery: 0, total: 0 },
  usage: { input: 0, output: 0, cached: 0 },
  retryCount: 0,
} satisfies Run;

const task = {
  id: "task-session-11-6",
  prompt: "targeted repair",
  repositoryPath: ".",
  revision: "HEAD",
  createdAt: "2026-08-26T00:00:00.000Z",
  verification: {},
} satisfies Task;

describe("SESSION 11.6 targeted false-strong repairs", () => {
  it("normalizes every semantically blank verification spec to one NOT_CHECKED identity", () => {
    const blankSpecs = [
      undefined,
      {},
      { command: "" },
      { command: " " },
      { command: "\t" },
      { command: "\n" },
      { command: " \t\n  " },
      { expectedFile: " " },
    ];
    const normalized = blankSpecs.map((spec) => normalizeVerificationSpecification(spec));
    expect(new Set(normalized.map((item) => item.status))).toEqual(new Set(["NOT_CONFIGURED"]));
    expect(new Set(normalized.map((item) => item.identity)).size).toBe(1);

    expect(normalizeVerificationSpecification({ command: "  npm test  " })).toMatchObject({
      status: "CONFIGURED",
      command: "npm test",
    });
    expect(normalizeVerificationSpecification({ expectedFile: "./proof.txt" })).toMatchObject({
      status: "CONFIGURED",
      expectedFile: "proof.txt",
    });
    for (const expectedFile of ["../proof.txt", "/tmp/proof.txt", "C:\\proof.txt", "\0"]) {
      expect(normalizeVerificationSpecification({ expectedFile }).status).toBe("INVALID");
    }
  });

  it("never executes a shell for whitespace-only verification", async () => {
    const result = await new CommandVerifier().verify(
      run,
      { ...task, verification: { command: " \t\n" } },
      { path: process.cwd() } as Sandbox,
      { patch: "", changedFiles: [] } as SandboxDiff,
    );
    expect(result.state).toBe("NOT_CHECKED");
    expect(result.execution).toBeUndefined();
  });

  it("keeps the quality read model on NOT_CHECKED when a raw whitespace command bypasses the API", () => {
    const risk = deriveRiskVector({
      files: [],
      moduleOwnership: {},
      packageOwnership: {},
      crossModuleEdgeCount: 0,
    });
    const plan = buildAssurancePlan(risk, "BALANCED");
    const report = deriveQualityReport({
      verificationState: "VERIFIED",
      verificationCommand: " \t\n",
      verificationExitCode: 0,
      assurancePlan: plan,
      preExecutionRisk: risk,
      diffRisk: risk,
      changedFiles: [],
      initialModules: [],
      moduleOwnership: {},
      diffPatch: "",
    });
    expect(report.Correctness.state).toBe("NOT_CHECKED");
  });

  it("materializes captured bytes, excludes .git, and rejects authored out-of-root reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "maf-session-11-6-"));
    try {
      await writeFile(path.join(root, "proof.txt"), "captured\n", "utf8");
      const entry = {
        path: "proof.txt",
        mode: "100644" as const,
        digest: createHash("sha256").update("captured\n").digest("hex"),
      };
      const sandbox = {
        path: root,
        repositoryPath: root,
        id: "sandbox",
        revision: "HEAD",
        baseRevision: "base",
      } satisfies Sandbox;
      const diff = {
        changedFiles: ["proof.txt"],
        identityDigest: digestManifest([entry]),
        candidateManifest: [entry],
        patch: "",
      } satisfies SandboxDiff;
      const materialized = await materializeVerificationCandidate(sandbox, diff, ["proof.txt"]);
      expect(await readFile(path.join(materialized.rootPath, "proof.txt"), "utf8")).toBe(
        "captured\n",
      );
      await materialized.cleanup();

      const unsafe = "module.exports = require('../outside');\n";
      await writeFile(path.join(root, "probe.js"), unsafe, "utf8");
      const unsafeEntry = {
        path: "probe.js",
        mode: "100644" as const,
        digest: createHash("sha256").update(unsafe).digest("hex"),
      };
      await expect(
        materializeVerificationCandidate(
          sandbox,
          {
            changedFiles: ["probe.js"],
            identityDigest: digestManifest([unsafeEntry]),
            candidateManifest: [unsafeEntry],
            patch: "",
          },
          ["probe.js"],
        ),
      ).rejects.toThrow(/out-of-root|outside/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a layer-boundary PASS satisfy a coupling-impact obligation", () => {
    const fileA = "packages/a/src/index.ts";
    const fileB = "packages/b/src/index.ts";
    const files = [fileA, fileB];
    const risk = deriveRiskVector({
      files,
      moduleOwnership: { [fileA]: "a", [fileB]: "b" },
      packageOwnership: { [fileA]: "packages/a", [fileB]: "packages/b" },
      crossModuleEdgeCount: 0,
    });
    const plan = buildAssurancePlan(risk, "BALANCED");
    expect(plan.requiredPredicates?.ARCHITECTURE).toEqual(["ARCHITECTURE.COUPLING_IMPACT"]);
    const report = deriveQualityReport({
      verificationState: "VERIFIED",
      verificationCommand: "npm test",
      verificationExitCode: 0,
      assurancePlan: plan,
      preExecutionRisk: risk,
      diffRisk: risk,
      changedFiles: files,
      initialModules: ["a", "b"],
      moduleOwnership: { [fileA]: "a", [fileB]: "b" },
      diffPatch: "",
    });
    const trust = deriveTrustState("VERIFIED", report, plan, undefined, { diffPatch: "" });
    expect(trust).toBe("CORRECTNESS_VERIFIED");
    expect(report.Architecture.predicateIdentity).toBe("ARCHITECTURE.LAYER_BOUNDARY");
  });

  it("leaves a dependency-inventory residual when no scanner establishes absence", () => {
    const projection = projectCapabilityConcerns([], {
      changedFiles: ["package-lock.json"],
      candidateId: "candidate-lockfile",
      diffDigest: "digest-lockfile",
    });
    expect(projection.concerns).toMatchObject([
      expect.objectContaining({ concern: "SECURITY.DEPENDENCY_VULNERABILITY" }),
    ]);
    const risk = deriveRiskVector({
      files: ["package-lock.json"],
      moduleOwnership: {},
      packageOwnership: {},
      crossModuleEdgeCount: 0,
    });
    const plan = buildAssurancePlan(risk, "BALANCED");
    const report = deriveQualityReport({
      verificationState: "VERIFIED",
      verificationCommand: "npm test",
      verificationExitCode: 0,
      assurancePlan: plan,
      preExecutionRisk: risk,
      diffRisk: risk,
      changedFiles: ["package-lock.json"],
      initialModules: [],
      moduleOwnership: {},
      diffPatch: "",
    });
    const obligations = assuranceObligationsFor(report, plan, {
      candidateId: "candidate-lockfile",
      diffDigest: "digest-lockfile",
      diffPatch: "",
      capabilityConcerns: projection.concerns,
      capabilityConcernEvidence: projection.concernEvidence,
    });
    expect(
      unresolvedObligations(obligations).some((item) => item.id.startsWith("SECURITY.DEPENDENCY")),
    ).toBe(true);
  });

  it("requires mission trust updates to agree with an already-bound execution", () => {
    const node: MissionNode = {
      id: "node",
      dependencyIds: [],
      state: "READY",
      executionMode: "GUIDED",
      agent: "fixture",
      model: "fixture",
      budget: 0,
      inputs: [],
      outputs: [],
      verificationState: "PROPOSED",
    };
    const tree = new MissionTree(node);
    tree.bindExecution("mission", "node", "task-a", "run-a");
    expect(() =>
      tree.setVerification("node", "VERIFIED", [], "MERGE_ELIGIBLE", {
        runId: "run-b",
        candidateId: "candidate",
        candidateDigest: "digest",
        verificationId: "verification",
      }),
    ).toThrow(/different run/iu);
  });
});
