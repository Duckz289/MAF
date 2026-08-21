import { describe, expect, it } from "vitest";

import {
  deriveChangeHealth,
  deriveHealthTrend,
  deriveMaintenanceNeed,
  deriveOperationalHealth,
  deriveStructuralHealth,
  isHealthSample,
  type HealthSample,
} from "../src/domain/health";
import type { RepositorySnapshot, TelemetryRecord } from "../src/domain/ports";

const snapshotWith = (overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot => {
  const base: RepositorySnapshot = {
    revision: "rev-1",
    files: ["src/domain/a.ts", "src/domain/b.ts", "src/infra/c.ts"],
    filesTruncated: false,
    symbols: [],
    relations: [
      { from: "src/domain/a.ts", to: "src/domain/b.ts", kind: "IMPORTS" },
      { from: "src/domain/b.ts", to: "src/domain/a.ts", kind: "IMPORTS" },
      { from: "src/infra/c.ts", to: "src/domain/a.ts", kind: "IMPORTS" },
    ],
    moduleMap: {},
    moduleOwnership: {
      "src/domain/a.ts": "domain",
      "src/domain/b.ts": "domain",
      "src/infra/c.ts": "infrastructure",
    },
    packageOwnership: {
      "src/domain/a.ts": "src",
      "src/domain/b.ts": "src",
      "src/infra/c.ts": "src",
    },
    moduleRoots: ["src"],
    parsedFiles: ["src/domain/a.ts", "src/domain/b.ts", "src/infra/c.ts"],
    scopeTruncated: false,
    evidence: [],
    ...overrides,
  };
  if (overrides.evidence === undefined) {
    base.evidence = base.parsedFiles.map((uri) => ({ uri, digest: "a".repeat(64) }));
  }
  return base;
};

const telemetryRecord = (overrides: Partial<TelemetryRecord> = {}): TelemetryRecord => ({
  taskId: "task-1",
  runId: "run-1",
  agent: "codex",
  model: "model-a",
  provider: "p",
  initialMode: "GUIDED",
  finalMode: "GUIDED",
  finalDesiredMode: "GUIDED",
  executionMode: "GUIDED",
  policyLiveUpdates: 0,
  policyBoundaryEnforcements: 0,
  policySafeRestarts: 0,
  pendingPolicyAtCompletion: false,
  inputTokens: 1000,
  outputTokens: 500,
  cachedTokens: 0,
  modelCost: 0.1,
  sandboxCost: 0,
  verificationCost: 0,
  retryCost: 0,
  recoveryCost: 0,
  latencyMs: 1000,
  retryCount: 0,
  filesChanged: 1,
  verificationType: "command",
  verificationState: "VERIFIED",
  modeTransitions: 0,
  strictReexpansions: 0,
  signalSnapshots: 0,
  dependencyExpansion: 0,
  touchedModules: 1,
  crossModuleEdges: 0,
  verifierFailures: 0,
  verificationAttempts: 1,
  repairAttempts: 0,
  moduleCountObserved: 1,
  stabilizationInvalidations: 0,
  contextExpansion: 0,
  verifiedSuccess: true,
  budgetMode: "ADVISORY",
  budgetLimitUsd: null,
  budgetExhausted: false,
  timestamp: "2026-08-20T00:00:00Z",
  ...overrides,
});

const healthIdentity = (runId: string, projectId = "project-a") => ({
  projectId,
  runId,
  revision: "resolved-revision",
  candidateId: `candidate-${runId}`,
  candidateDigest: "a".repeat(64),
  evidenceBasis: "VERIFIED_CANDIDATE" as const,
  structuralBasis: "BASE_REVISION" as const,
  changeBasis: "VERIFIED_CANDIDATE_DIFF" as const,
});

describe("deriveStructuralHealth", () => {
  it("counts modules, cross-module edges, and the import cycle (Tarjan SCC)", () => {
    const health = deriveStructuralHealth(snapshotWith());
    expect(health.moduleCount).toBe(2);
    expect(health.fileCount).toBe(3);
    expect(health.largestModule).toBe("domain");
    expect(health.largestModuleFiles).toBe(2);
    // a→b, b→a is one cycle of 2 files; c→a crosses modules.
    expect(health.importCycleCount).toBe(1);
    expect(health.largestCycleFiles).toBe(2);
    expect(health.crossModuleEdges).toBe(1);
    expect(health.parsedCoverage).toBe(1);
  });

  it("reports parsed coverage honestly when only a subset was parsed", () => {
    const health = deriveStructuralHealth(
      snapshotWith({
        parsedFiles: ["src/domain/a.ts", "src/domain/b.ts"],
        // b was attempted but lacked successful parse/digest evidence.
        evidence: [{ uri: "src/domain/a.ts", digest: "a".repeat(64) }],
      }),
    );
    expect(health.parsedCoverage).toBeCloseTo(1 / 3);
    expect(health.fileScanComplete).toBe(false);
  });

  it("does not claim complete structure when inventory or scope was truncated", () => {
    const inventory = deriveStructuralHealth(snapshotWith({ filesTruncated: true }));
    const scope = deriveStructuralHealth(snapshotWith({ scopeTruncated: true }));
    expect(inventory.parsedCoverage).toBe(1);
    expect(inventory.inventoryTruncated).toBe(true);
    expect(inventory.fileScanComplete).toBe(false);
    expect(scope.fileScanComplete).toBe(false);
  });

  it("counts a self-import as a one-file cycle", () => {
    const health = deriveStructuralHealth(
      snapshotWith({
        relations: [{ from: "src/domain/a.ts", to: "src/domain/a.ts", kind: "IMPORTS" }],
      }),
    );
    expect(health.importCycleCount).toBe(1);
    expect(health.largestCycleFiles).toBe(1);
  });

  it("handles an empty snapshot without inventing structure", () => {
    const health = deriveStructuralHealth(
      snapshotWith({ files: [], relations: [], parsedFiles: [], moduleOwnership: {} }),
    );
    expect(health.moduleCount).toBe(0);
    expect(health.importCycleCount).toBe(0);
    expect(health.crossModuleEdges).toBe(0);
    expect(health.parsedCoverage).toBe(0);
  });
});

describe("deriveChangeHealth", () => {
  it("counts unsafe type escapes and skipped tests with file evidence", () => {
    const patch = [
      "diff --git a/src/domain/a.ts b/src/domain/a.ts",
      "--- a/src/domain/a.ts",
      "+++ b/src/domain/a.ts",
      "@@ -1,3 +1,5 @@",
      "+const x: any = 1;",
      "+const y = z as unknown as W;",
      "diff --git a/tests/a.test.ts b/tests/a.test.ts",
      "--- a/tests/a.test.ts",
      "+++ b/tests/a.test.ts",
      "@@ -1,2 +1,4 @@",
      '+it.skip("broken", () => {});',
      '+it.todo("later");',
    ].join("\n");
    const health = deriveChangeHealth(patch);
    expect(health.unsafeTypeEscapes).toBe(2);
    expect(health.escapeDetails[0]).toContain("src/domain/a.ts");
    expect(health.skippedTests).toBe(2);
    expect(health.skipDetails[0]).toContain("tests/a.test.ts");
  });

  it("counts relative import forms and TypeScript suppression directives after lexical filtering", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,6 @@",
      '+import value from "./value"; const fakeImport = `from "./fake"`;',
      '+import "./side-effect";',
      '+const dynamic = import("../dynamic");',
      '+const common = require("../common");',
      "+// @ts-expect-error trusted debt probe",
      '+const fakeDirective = "// @ts-expect-error";',
    ].join("\n");
    const health = deriveChangeHealth(patch);
    expect(health.addedImports).toBe(4);
    expect(health.unsafeTypeEscapes).toBe(1);
  });

  it("marks binary/git metadata changes as incomplete rather than clean zeroes", () => {
    const patch = [
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 123..456 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ",
    ].join("\n");
    const current = deriveChangeHealth(patch);
    expect(current.changeEvidenceComplete).toBe(false);
    expect(current.uninspectableFiles).toBe(1);
    const trend = deriveHealthTrend(
      { ...healthIdentity("run-before"), timestamp: "t1", change: deriveChangeHealth("") },
      { ...healthIdentity("run-binary"), timestamp: "t2", change: current },
    );
    expect(trend.incomplete).toBe(true);
    expect(trend.metrics.filter((metric) => metric.group === "change")).toEqual(
      expect.arrayContaining([expect.objectContaining({ direction: "UNKNOWN" })]),
    );
    expect(deriveMaintenanceNeed(trend).needed).toBe(false);
  });

  it("does not count skip markers in non-test files", () => {
    const patch = [
      "diff --git a/src/domain/a.ts b/src/domain/a.ts",
      "--- a/src/domain/a.ts",
      "+++ b/src/domain/a.ts",
      "@@ -1,1 +1,2 @@",
      '+it.skip("not a test file", () => {});',
    ].join("\n");
    expect(deriveChangeHealth(patch).skippedTests).toBe(0);
  });

  it("counts only keys added inside package dependency sections", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,6 +1,9 @@",
      " {",
      '   "name": "maf",',
      '+  "description": "not a dependency",',
      '   "dependencies": {',
      '+    "left-pad": "^1.0.0",',
      '     "zod": "4.1.5"',
      "   },",
      '+  "scripts": "also not a dependency"',
      " }",
    ].join("\n");
    expect(deriveChangeHealth(patch).addedPackageDependencies).toBe(1);
  });

  it("does not guess a dependency section when an isolated package.json hunk lacks context", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -50,1 +50,2 @@",
      '+    "looks-like-a-package": "^1.0.0",',
    ].join("\n");
    expect(deriveChangeHealth(patch).addedPackageDependencies).toBe(0);
  });

  it("does not count dependency upgrades as newly added packages", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,4 +1,4 @@",
      '   "dependencies": {',
      '-    "zod": "1.0.0"',
      '+    "zod": "2.0.0"',
      "   }",
    ].join("\n");
    expect(deriveChangeHealth(patch).addedPackageDependencies).toBe(0);
  });

  it("treats dependency section moves as existing packages across multiple manifests", () => {
    const patch = [
      'diff --git "a/packages/app one/package.json" "b/packages/app one/package.json"',
      '--- "a/packages/app one/package.json"',
      '+++ "b/packages/app one/package.json"',
      "@@ -1,7 +1,7 @@",
      '   "dependencies": {',
      '-    "zod": "2.0.0"',
      "   },",
      '   "devDependencies": {',
      '+    "zod": "2.0.0"',
      "   }",
      "diff --git a/packages/two/package.json b/packages/two/package.json",
      "--- a/packages/two/package.json",
      "+++ b/packages/two/package.json",
      "@@ -1,3 +1,4 @@",
      '   "dependencies": {',
      '+    "new-package": "1.0.0"',
      "   }",
    ].join("\n");
    expect(deriveChangeHealth(patch).addedPackageDependencies).toBe(1);
  });

  it("does not persist raw source text or scan documentation/string literals as code", () => {
    const secret = `ghp_${"x".repeat(40)}`;
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,3 @@",
      `+const credential: any = "${secret}";`,
      '+const prose = "value: any and if (fake)";',
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,2 @@",
      "+Example: value: any",
    ].join("\n");
    const health = deriveChangeHealth(patch);
    expect(health.unsafeTypeEscapes).toBe(1);
    expect(JSON.stringify(health)).not.toContain(secret);
  });

  it("collapses overlapping windows from one copied region", () => {
    const block = Array.from({ length: 6 }, (_, index) => `+const value${index} = source${index};`);
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1,7 @@",
      ...block,
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1,7 @@",
      ...block,
    ].join("\n");
    expect(deriveChangeHealth(patch).duplicatedBlocks).toBe(1);
  });

  it("flags duplicated 5-line blocks across files in the same patch", () => {
    const block = [
      "+const first = computeOne(input);",
      "+const second = computeTwo(first);",
      "+const third = computeThree(second);",
      "+const fourth = computeFour(third);",
      "+const fifth = computeFive(fourth);",
    ];
    const patch = [
      "diff --git a/src/domain/a.ts b/src/domain/a.ts",
      "--- a/src/domain/a.ts",
      "+++ b/src/domain/a.ts",
      "@@ -1,1 +1,6 @@",
      ...block,
      "diff --git a/src/domain/b.ts b/src/domain/b.ts",
      "--- b/src/domain/b.ts",
      "+++ b/src/domain/b.ts",
      "@@ -1,1 +1,6 @@",
      ...block,
    ].join("\n");
    const health = deriveChangeHealth(patch);
    expect(health.duplicatedBlocks).toBeGreaterThanOrEqual(1);
    expect(health.duplicationEvidence[0]).toContain("src/domain/a.ts + src/domain/b.ts");
  });

  it("flags complexity hotspots by added branch points", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `+if (cond${i}) { doIt${i}(); }`).join("\n");
    const patch = [
      "diff --git a/src/domain/big.ts b/src/domain/big.ts",
      "--- a/src/domain/big.ts",
      "+++ b/src/domain/big.ts",
      "@@ -1,1 +1,13 @@",
      lines,
    ].join("\n");
    expect(deriveChangeHealth(patch).complexityHotspots[0]).toContain("src/domain/big.ts");
  });
});

describe("deriveOperationalHealth", () => {
  it("returns undefined for an empty window — unknown, not zero", () => {
    expect(deriveOperationalHealth([])).toBeUndefined();
  });

  it("averages per-task metrics and records the model mix", () => {
    const health = deriveOperationalHealth([
      telemetryRecord({ model: "model-a", inputTokens: 1000, retryCount: 1 }),
      telemetryRecord({
        model: "model-b",
        inputTokens: 3000,
        retryCount: 0,
        strictReexpansions: 2,
        verifierFailures: 1,
        toolCalls: 8,
        contextChars: 40000,
      }),
    ]);
    expect(health?.tokensPerTask).toBe(2500);
    expect(health?.retriesPerTask).toBe(0.5);
    expect(health?.verifierFailuresPerTask).toBe(0.5);
    expect(health?.frontierEscalationRate).toBe(0.5);
    expect(health?.modelMix).toEqual({ "model-a": 1, "model-b": 1 });
    // toolCalls/contextChars are null unless every record carries them.
    expect(health?.toolCallsPerTask).toBeNull();
    expect(health?.contextCharsPerTask).toBeNull();
  });

  it("sanitizes credential-shaped model names before they become object keys", () => {
    const secret = `ghp_${"q".repeat(40)}`;
    const health = deriveOperationalHealth([telemetryRecord({ model: secret })]);
    expect(JSON.stringify(health)).not.toContain(secret);
  });

  it("preserves special model names as inert own keys", () => {
    const health = deriveOperationalHealth([
      telemetryRecord({ model: "__proto__" }),
      telemetryRecord({ model: "constructor" }),
    ]);
    expect(Object.hasOwn(health?.modelMix ?? {}, "__proto__")).toBe(true);
    expect(health?.modelMix.__proto__).toBe(1);
    expect(health?.modelMix.constructor).toBe(1);
  });
});

describe("deriveHealthTrend", () => {
  it("refuses to compare samples from different projects", () => {
    const structural = deriveStructuralHealth(snapshotWith());
    const trend = deriveHealthTrend(
      { ...healthIdentity("run-1"), timestamp: "t1", structural },
      { ...healthIdentity("run-2", "project-b"), timestamp: "t2", structural },
    );
    expect(trend).toEqual({ incomplete: true, metrics: [] });
  });

  it("marks the trend incomplete when one sample lacks a group the other has", () => {
    const previous: HealthSample = {
      ...healthIdentity("run-1"),
      timestamp: "t1",
      structural: deriveStructuralHealth(snapshotWith()),
    };
    const current: HealthSample = {
      ...healthIdentity("run-2"),
      timestamp: "t2",
      structural: deriveStructuralHealth(snapshotWith()),
      operational: deriveOperationalHealth([telemetryRecord()]),
    };
    const trend = deriveHealthTrend(previous, current);
    expect(trend.incomplete).toBe(true);
    expect(trend.metrics.some((metric) => metric.group === "structural")).toBe(true);
  });

  it("keeps structural direction unknown without proven revision lineage", () => {
    const base = deriveStructuralHealth(snapshotWith());
    const grown = deriveStructuralHealth(
      snapshotWith({
        files: [...snapshotWith().files, "src/infra/d.ts", "src/infra/e.ts", "src/infra/f.ts"],
        relations: [
          ...snapshotWith().relations,
          { from: "src/infra/d.ts", to: "src/domain/a.ts", kind: "IMPORTS" },
          { from: "src/infra/e.ts", to: "src/domain/b.ts", kind: "IMPORTS" },
          { from: "src/infra/f.ts", to: "src/domain/a.ts", kind: "IMPORTS" },
          { from: "src/domain/a.ts", to: "src/infra/c.ts", kind: "IMPORTS" },
        ],
        moduleOwnership: {
          ...snapshotWith().moduleOwnership,
          "src/infra/d.ts": "infrastructure",
          "src/infra/e.ts": "infrastructure",
          "src/infra/f.ts": "infrastructure",
        },
        packageOwnership: {
          ...snapshotWith().packageOwnership,
          "src/infra/d.ts": "src",
          "src/infra/e.ts": "src",
          "src/infra/f.ts": "src",
        },
        parsedFiles: [
          "src/domain/a.ts",
          "src/domain/b.ts",
          "src/infra/c.ts",
          "src/infra/d.ts",
          "src/infra/e.ts",
          "src/infra/f.ts",
        ],
      }),
    );
    const trend = deriveHealthTrend(
      { ...healthIdentity("run-1"), timestamp: "t1", structural: base },
      { ...healthIdentity("run-2"), timestamp: "t2", structural: grown },
    );
    const coupling = trend.metrics.find((metric) => metric.metric === "crossModuleEdges");
    expect(coupling?.direction).toBe("UNKNOWN");
    expect(trend.incomplete).toBe(true);
    expect(coupling?.previous).toBe(1);
    expect(coupling?.current).toBe(5);
  });

  it("does not label a smaller positive debt addition as improvement", () => {
    const prior = deriveChangeHealth(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,1 +1,4 @@",
        "+const a: any = 1;",
        "+const b: any = 2;",
        "+const c: any = 3;",
      ].join("\n"),
    );
    const current = deriveChangeHealth(
      [
        "diff --git a/src/b.ts b/src/b.ts",
        "--- a/src/b.ts",
        "+++ b/src/b.ts",
        "@@ -1,1 +1,2 @@",
        "+const stillDebt: any = 1;",
      ].join("\n"),
    );
    const trend = deriveHealthTrend(
      { ...healthIdentity("run-1"), timestamp: "t1", change: prior },
      { ...healthIdentity("run-2"), timestamp: "t2", change: current },
    );
    expect(trend.metrics.find((metric) => metric.metric === "unsafeTypeEscapes")?.direction).toBe(
      "DEGRADING",
    );
    expect(deriveMaintenanceNeed(trend).needed).toBe(true);
  });
});

describe("deriveMaintenanceNeed", () => {
  it("proposes maintenance on materially degraded structural dimensions with numbers", () => {
    const trend = deriveHealthTrend(
      {
        ...healthIdentity("run-1"),
        timestamp: "t1",
        change: { ...deriveChangeHealth(""), addedImports: 0 },
      },
      {
        ...healthIdentity("run-2"),
        timestamp: "t2",
        change: deriveChangeHealth(
          [
            "diff --git a/src/domain/a.ts b/src/domain/a.ts",
            "--- a/src/domain/a.ts",
            "+++ b/src/domain/a.ts",
            "@@ -1,1 +1,2 @@",
            "+const x: any = 1;",
          ].join("\n"),
        ),
      },
    );
    const need = deriveMaintenanceNeed(trend);
    expect(need.needed).toBe(true);
    expect(need.reasons.some((reason) => reason.includes("unsafe type escape"))).toBe(true);
  });

  it("does not propose maintenance on flat or improving trends", () => {
    const structural = deriveStructuralHealth(snapshotWith());
    const trend = deriveHealthTrend(
      { ...healthIdentity("run-1"), timestamp: "t1", structural },
      { ...healthIdentity("run-2"), timestamp: "t2", structural },
    );
    expect(deriveMaintenanceNeed(trend).needed).toBe(false);
  });

  it("reports rising frontier escalation without claiming it caused structural friction", () => {
    const trend = deriveHealthTrend(
      {
        ...healthIdentity("run-1"),
        timestamp: "t1",
        operational: deriveOperationalHealth([
          telemetryRecord({ strictReexpansions: 0 }),
          telemetryRecord({ strictReexpansions: 0 }),
        ]),
      },
      {
        ...healthIdentity("run-2"),
        timestamp: "t2",
        operational: deriveOperationalHealth([
          telemetryRecord({ strictReexpansions: 3 }),
          telemetryRecord({ strictReexpansions: 2 }),
        ]),
      },
    );
    const need = deriveMaintenanceNeed(trend);
    expect(need.needed).toBe(true);
    expect(need.reasons.join(" ")).toContain("without assuming a cause");
    expect(need.escalationCorrelationNote).toBeUndefined();
  });

  it("notes correlation when measured change damage and escalation rise together", () => {
    const trend = deriveHealthTrend(
      {
        ...healthIdentity("run-1"),
        timestamp: "t1",
        change: deriveChangeHealth(""),
        operational: deriveOperationalHealth([telemetryRecord({ strictReexpansions: 0 })]),
      },
      {
        ...healthIdentity("run-2"),
        timestamp: "t2",
        change: {
          ...deriveChangeHealth(""),
          unsafeTypeEscapes: 1,
          escapeDetails: ["src/a.ts: const value: any = input"],
        },
        operational: deriveOperationalHealth([telemetryRecord({ strictReexpansions: 1 })]),
      },
    );
    expect(deriveMaintenanceNeed(trend).escalationCorrelationNote).toContain("coincided");
  });

  it("rejects non-string and unbounded detail evidence", () => {
    const sample = {
      ...healthIdentity("run-guard"),
      timestamp: "2026-08-21T00:00:00.000Z",
      change: { ...deriveChangeHealth(""), escapeDetails: [{}] },
    };
    expect(isHealthSample(sample)).toBe(false);
  });
});
