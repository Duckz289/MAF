import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GuidedContextBuilder } from "../src/application/context-builder";
import { RunService } from "../src/application/run-service";
import { EvidenceRuntimeSignalCollector } from "../src/application/runtime-signal-collector";
import type { AssurancePlan } from "../src/domain/assurance";
import {
  type AssuranceQuestionEvidence,
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveDiscoveryAdequacyEvidence } from "../src/domain/discovery-adequacy";
import { MissionTree, type MissionNode } from "../src/domain/mission-tree";
import type { AgentAdapter, VerifierPort } from "../src/domain/ports";
import {
  assuranceObligationsFor,
  deriveTrustState,
  type QualityReport,
} from "../src/domain/quality";
import type { Run, Verification } from "../src/domain/types";
import { LocalWorktreeSandbox } from "../src/infrastructure/local-worktree";
import { InMemoryRunStore } from "../src/infrastructure/memory-store";
import { NativeCliAdapter } from "../src/infrastructure/native-cli-adapter";
import { InMemoryProjectBrain, LocalRepositoryIndex } from "../src/infrastructure/project-brain";
import { DomainTelemetryRecorder } from "../src/infrastructure/telemetry";
import { createFixtureRepository, type FixtureRepository, waitFor } from "./helpers";

const patchFor = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

const patchesFor = (...files: Array<[string, string[]]>): string =>
  files.map(([file, added]) => patchFor(file, added)).join("\n");

const removalPatchFor = (file: string, removed: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +0,0 @@`,
    ...removed.map((line) => `-${line}`),
  ].join("\n");

const check = (
  state: QualityReport["Security"]["state"],
  coverage: QualityReport["Security"]["coverage"] = "FULL",
): QualityReport["Security"] => ({
  state,
  evidence: ["discovery-adequacy fixture"],
  provenance: "DETERMINISTIC",
  coverage,
});

const report = (): QualityReport => ({
  Correctness: check("PASS"),
  Architecture: check("NOT_REQUIRED"),
  Maintainability: check("PASS"),
  Security: check("PASS"),
  Performance: check("NOT_REQUIRED"),
  Resilience: check("NOT_REQUIRED"),
  TestQuality: check("PASS"),
  DebtDelta: check("PASS"),
});

const everyCheck: AssurancePlan["required"] = [
  "CORRECTNESS",
  "INTEGRATION",
  "ARCHITECTURE",
  "DEBT",
  "SECURITY",
  "PERFORMANCE",
  "CONCURRENCY",
  "RESILIENCE",
  "INDEPENDENT_REVIEW",
];

const correctnessOnlyPlan: AssurancePlan = {
  required: ["CORRECTNESS"],
  notRequired: everyCheck.filter((item) => item !== "CORRECTNESS"),
  reasons: Object.fromEntries(
    everyCheck.map((item) => [item, "fixture requirement"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};

const bindingFor = (diffPatch: string) => ({
  candidateId: "candidate-discovery-adequacy",
  diffDigest: "digest-discovery-adequacy",
  diffPatch,
  qualityPreference: "BALANCED" as const,
});

describe("planner-independent discovery adequacy", () => {
  const incompleteShapes: Array<[string, string, string[]]> = [
    ["ownership", "src/core/visibility.ts", ["row.createdBy === viewer.id;"]],
    ["membership", "src/core/membership.ts", ["subject.groups.has(team.id);"]],
    ["resource visibility", "src/core/view.ts", ["return resource.visibleTo.includes(actor.id);"]],
    ["entitlement data", "src/core/tier.ts", ["return account.tier >= feature.minimumTier;"]],
    ["execution wrapper", "src/core/tool.ts", ["invokeConfigured(request.command);"]],
    ["deserialization shape", "src/core/codec.py", ["marshal.decode(payload)"]],
    ["dynamic target", "src/core/navigation.ts", ["response.move(request.query.target);"]],
    ["fixed-argument decision branch", "src/core/branch.ts", ["if (evaluate('routine')) {"]],
    ["policy data", "config/access.json", ['"subjects": ["*"]']],
    ["workflow input", "workflows/task.yaml", [`execute: \${request.value}`]],
    ["uncommon language", "src/core/tool.rs", ["engine::apply(&external_value);"]],
  ];

  for (const [label, file, added] of incompleteShapes) {
    it(`turns admitted INCOMPLETE scope into a material obligation for ${label}`, () => {
      const diffPatch = patchFor(file, added);
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.concerns).toEqual([]);
      expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
      const obligations = assuranceObligationsFor(
        report(),
        correctnessOnlyPlan,
        bindingFor(diffPatch),
      );
      expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
        check: "DISCOVERY_ADEQUACY",
        material: true,
        status: discovery.scopeAdequacy.coverage === "UNSUPPORTED" ? "UNSUPPORTED" : "NOT_CHECKED",
        producedBy: "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
        candidateId: "candidate-discovery-adequacy",
        diffDigest: "digest-discovery-adequacy",
      });
      expect(
        deriveTrustState(
          "VERIFIED",
          report(),
          correctnessOnlyPlan,
          undefined,
          bindingFor(diffPatch),
        ),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("keeps a typed concern independent from the discovery-adequacy obligation", () => {
    // The decision region must be one the bounded analyzer can actually PROVE it covered.
    // `tenantPolicy.allowed` is an arbitrary property read (a getter may do anything), so it is
    // deliberately NOT whole-unit covered any more; a comparison of local values is.
    const diffPatch = patchFor("src/core/policy.ts", ["if (tenantRole === adminRole) {"]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAdequacy.conclusion).toBe("CONCERNS_FOUND");
    const obligations = assuranceObligationsFor(
      report(),
      correctnessOnlyPlan,
      bindingFor(diffPatch),
    );
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      status: "PASS",
      material: true,
      producedBy: "DISCOVERY.CONCERN_WITNESS",
    });
    expect(
      obligations.find((item) => item.id.startsWith("SECURITY.AUTHORIZATION_BEHAVIOR")),
    ).toMatchObject({ material: true, status: "NOT_CHECKED" });
    expect(unresolvedObligations(obligations).map((item) => item.id)).toContain(
      "SECURITY.AUTHORIZATION_BEHAVIOR.NO_CAPABILITY",
    );
  });

  it("allows a later complete candidate-bound classifier record to resolve prior incompleteness", () => {
    const diffPatch = patchFor("src/core/opaque.ts", ["evaluateLocally(candidateValue);"]);
    const discovery = discoverConcerns(diffPatch);
    const incomplete = deriveDiscoveryAdequacyEvidence({
      discovery,
      candidateId: "candidate-escalated",
      diffDigest: "digest-escalated",
    });
    const stronger: AssuranceQuestionEvidence = {
      ...incomplete,
      outcome: "PASS",
      claim: "NEGATIVE_ABSENCE",
      completeness: "COMPLETE",
      coverage: "FULL",
      discoveryScope: {
        unit: discovery.scopeAccounting.unit,
        totalRelevantUnits: discovery.scopeAccounting.totalRelevantUnits,
        coveredUnits: discovery.scopeAccounting.totalRelevantUnits,
        residualUnits: 0,
        // P1.3: a stronger record must name the exact units it analyzed, not just how many.
        unitIdentities: discovery.scopeAccounting.unitIdentities,
      },
      analysisScope:
        "stronger candidate-bound scope expansion completely classified every changed statement",
      evidence: ["stronger applicable scope analysis completed for this candidate and digest"],
    };
    const obligations = deriveAssuranceObligations({
      plan: correctnessOnlyPlan,
      report: report(),
      discovery,
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      candidateId: "candidate-escalated",
      diffDigest: "digest-escalated",
      assuranceQuestionEvidence: [incomplete, stronger],
    });
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      status: "PASS",
      material: true,
      producedBy: "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });

  it("rejects a stronger record whose unit identities are not this candidate's scope", () => {
    // P1.3: right COUNT, wrong SET. A producer that analyzed a different set of units must not
    // discharge this candidate's scope obligation on arithmetic alone.
    const diffPatch = patchFor("src/core/opaque.ts", ["evaluateLocally(candidateValue);"]);
    const discovery = discoverConcerns(diffPatch);
    const incomplete = deriveDiscoveryAdequacyEvidence({
      discovery,
      candidateId: "candidate-identity",
      diffDigest: "digest-identity",
    });
    const impostor: AssuranceQuestionEvidence = {
      ...incomplete,
      outcome: "PASS",
      claim: "NEGATIVE_ABSENCE",
      completeness: "COMPLETE",
      coverage: "FULL",
      discoveryScope: {
        unit: discovery.scopeAccounting.unit,
        totalRelevantUnits: discovery.scopeAccounting.totalRelevantUnits,
        coveredUnits: discovery.scopeAccounting.totalRelevantUnits,
        residualUnits: 0,
        unitIdentities: discovery.scopeAccounting.unitIdentities.map(
          (identity) => `${identity}::from-another-analysis`,
        ),
      },
      analysisScope: "a complete analysis of some other candidate's units",
      evidence: ["counts match but the analyzed unit identities are not this candidate's"],
    };
    const obligation = deriveAssuranceObligations({
      plan: correctnessOnlyPlan,
      report: report(),
      discovery,
      candidateId: "candidate-identity",
      diffDigest: "digest-identity",
      assuranceQuestionEvidence: [incomplete, impostor],
    }).find((item) => item.id === "DISCOVERY.ADEQUACY");
    expect(obligation).toMatchObject({ status: "NOT_CHECKED", material: true });
  });

  it("rejects magical COMPLETE evidence that does not identify coverage of prior residual scope", () => {
    const diffPatch = patchFor("src/core/opaque.ts", ["evaluateLocally(candidateValue);"]);
    const discovery = discoverConcerns(diffPatch);
    const incomplete = deriveDiscoveryAdequacyEvidence({
      discovery,
      candidateId: "candidate-unscoped",
      diffDigest: "digest-unscoped",
    });
    const unscoped: AssuranceQuestionEvidence = {
      ...incomplete,
      outcome: "PASS",
      completeness: "COMPLETE",
      coverage: "FULL",
      discoveryScope: undefined,
      analysisScope: "caller says complete without identifying consumed changed scope",
    };
    const obligation = deriveAssuranceObligations({
      plan: correctnessOnlyPlan,
      report: report(),
      discovery,
      candidateId: "candidate-unscoped",
      diffDigest: "digest-unscoped",
      assuranceQuestionEvidence: [incomplete, unscoped],
    }).find((item) => item.id === "DISCOVERY.ADEQUACY");
    expect(obligation).toMatchObject({ status: "NOT_CHECKED", material: true });
    expect(obligation?.evidence.join(" ")).toMatch(/structured changed-unit coverage/iu);
  });

  it("rejects a stronger adequacy record bound to another candidate", () => {
    const diffPatch = patchFor("src/core/opaque.ts", ["evaluateLocally(candidateValue);"]);
    const discovery = discoverConcerns(diffPatch);
    const incomplete = deriveDiscoveryAdequacyEvidence({
      discovery,
      candidateId: "candidate-current",
      diffDigest: "digest-current",
    });
    const stale: AssuranceQuestionEvidence = {
      ...incomplete,
      candidateId: "candidate-other",
      diffDigest: "digest-other",
      outcome: "PASS",
      completeness: "COMPLETE",
      coverage: "FULL",
    };
    const obligations = deriveAssuranceObligations({
      plan: correctnessOnlyPlan,
      report: report(),
      discovery,
      candidateId: "candidate-current",
      diffDigest: "digest-current",
      assuranceQuestionEvidence: [incomplete, stale],
    });
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")?.status).toBe(
      "NOT_CHECKED",
    );
  });

  it("lets an explicit incomplete remainder outrank a positive witness regardless of record order", () => {
    const diffPatch = patchFor("src/core/opaque.ts", ["evaluateLocally(candidateValue);"]);
    const discovery = discoverConcerns(diffPatch);
    const incomplete = deriveDiscoveryAdequacyEvidence({
      discovery,
      candidateId: "candidate-mixed-evidence",
      diffDigest: "digest-mixed-evidence",
    });
    const positive: AssuranceQuestionEvidence = {
      ...incomplete,
      producedBy: "DISCOVERY.CONCERN_WITNESS",
      outcome: "PASS",
      claim: "POSITIVE_FINDING",
      completeness: "NOT_APPLICABLE",
      coverage: "FULL",
      analysisScope: "one concrete concern witness only",
      evidence: ["one concrete concern was found"],
    };
    for (const records of [
      [positive, incomplete],
      [incomplete, positive],
    ]) {
      const adequacy = deriveAssuranceObligations({
        plan: correctnessOnlyPlan,
        report: report(),
        discovery,
        candidateId: "candidate-mixed-evidence",
        diffDigest: "digest-mixed-evidence",
        assuranceQuestionEvidence: records,
      }).find((item) => item.id === "DISCOVERY.ADEQUACY");
      expect(adequacy).toMatchObject({
        status: "NOT_CHECKED",
        material: true,
        producedBy: "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
      });
      expect(adequacy?.evidence.join(" ")).toMatch(/positive witness is not exhaustive/iu);
    }
  });
});

describe("changed-scope remainder accounting", () => {
  const resolvableSensitive = ["const p = await getpass('pin');", "const present = p.length > 0;"];

  const assertConcernCannotLaunderRemainder = (
    diffPatch: string,
    expectedRemainder: Partial<ReturnType<typeof discoverConcerns>["scopeAccounting"]>,
  ): void => {
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.concerns).toEqual([
      expect.objectContaining({ concern: "SECURITY.SENSITIVE_INPUT_FLOW" }),
    ]);
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(discovery.scopeAccounting).toMatchObject(expectedRemainder);
    const obligations = assuranceObligationsFor(
      report(),
      correctnessOnlyPlan,
      bindingFor(diffPatch),
    );
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      material: true,
      status: expectedRemainder.unsupportedUnits === 1 ? "UNSUPPORTED" : "NOT_CHECKED",
      producedBy: "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
    });
    expect(
      obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW")),
    ).toMatchObject({ material: true, status: "PASS" });
    expect(
      deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, bindingFor(diffPatch)),
    ).toBe("CORRECTNESS_VERIFIED");
  };

  it("keeps a resolvable concern and an unclassified sibling statement simultaneously visible", () => {
    assertConcernCannotLaunderRemainder(
      patchFor("src/core/mixed.ts", [...resolvableSensitive, "dispatchPrepared(request.payload);"]),
      {
        totalRelevantUnits: 3,
        concernAttributedUnits: 2,
        boundedClassifiedUnits: 1,
        unsupportedUnits: 0,
        unclassifiedRemainderUnits: 1,
      },
    );
  });

  it("keeps a resolvable concern and an unclassified second file simultaneously visible", () => {
    assertConcernCannotLaunderRemainder(
      patchesFor(
        ["src/core/pin.ts", resolvableSensitive],
        ["src/core/dispatch.ts", ["dispatchPrepared(request.payload);"]],
      ),
      {
        totalRelevantUnits: 3,
        concernAttributedUnits: 2,
        boundedClassifiedUnits: 1,
        unsupportedUnits: 0,
        unclassifiedRemainderUnits: 1,
      },
    );
  });

  it("does not let a resolvable concern launder unsupported YAML workflow scope", () => {
    assertConcernCannotLaunderRemainder(
      patchesFor(
        ["src/core/pin.ts", resolvableSensitive],
        ["workflows/release.yaml", [`execute: \${request.value}`]],
      ),
      {
        totalRelevantUnits: 3,
        concernAttributedUnits: 2,
        boundedClassifiedUnits: 1,
        unsupportedUnits: 1,
        unclassifiedRemainderUnits: 0,
      },
    );
  });

  it("does not let a resolvable concern launder an unmodelled-language file", () => {
    assertConcernCannotLaunderRemainder(
      patchesFor(
        ["src/core/pin.ts", resolvableSensitive],
        ["src/core/dispatch.rs", ["engine::apply(&external_value);"]],
      ),
      {
        totalRelevantUnits: 3,
        concernAttributedUnits: 2,
        boundedClassifiedUnits: 1,
        unsupportedUnits: 1,
        unclassifiedRemainderUnits: 0,
      },
    );
  });

  it("does not let a bounded benign statement launder an unclassified sibling", () => {
    const diffPatch = patchFor("src/core/mixed-benign.ts", [
      "const total = subtotal + tax;",
      "dispatchPrepared(request.payload);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.concerns).toEqual([]);
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernAttributedUnits: 0,
      boundedClassifiedUnits: 1,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 1,
    });
    const obligations = assuranceObligationsFor(
      report(),
      correctnessOnlyPlan,
      bindingFor(diffPatch),
    );
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      status: "NOT_CHECKED",
      material: true,
    });
    expect(
      deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, bindingFor(diffPatch)),
    ).toBe("CORRECTNESS_VERIFIED");
  });

  it("allows two fully accounted files to progress", () => {
    const diffPatch = patchesFor(
      ["src/core/math.ts", ["const total = subtotal + tax;"]],
      ["src/core/constants.ts", ["const RETRY_LIMIT = 4;"]],
    );
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernAttributedUnits: 0,
      boundedClassifiedUnits: 2,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(
      assuranceObligationsFor(report(), correctnessOnlyPlan, bindingFor(diffPatch)).find(
        (item) => item.id === "DISCOVERY.ADEQUACY",
      ),
    ).toMatchObject({ status: "PASS", material: true });
    expect(
      deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, bindingFor(diffPatch)),
    ).toBe("MERGE_ELIGIBLE");
  });

  it("accounts for removed arbitrary behavior instead of calling it empty scope", () => {
    const diffPatch = removalPatchFor("src/core/legacy.ts", ["initializeRuntime();"]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      fixedArgumentInvocationUnits: 1,
      boundedClassifiedUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(
      deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, bindingFor(diffPatch)),
    ).toBe("CORRECTNESS_VERIFIED");
  });

  it("keeps removed fixed-data syntax classified without granting absence authority", () => {
    const diffPatch = removalPatchFor("src/core/constants.ts", ["export const RETRY_LIMIT = 4;"]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      syntaxClassifiedUnits: 1,
      boundedClassifiedUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
  });
});

describe("bounded progressiveness", () => {
  const completelyClassified: Array<[string, string, string[], string]> = [
    [
      "fixed constant",
      "src/core/constants.ts",
      ["const RETRY_LIMIT = 4;"],
      "FIXED_DATA_DECLARATION",
    ],
    [
      "local arithmetic",
      "src/core/math.ts",
      ["const total = subtotal + tax;"],
      "LOCAL_SCALAR_COMPUTATION",
    ],
    [
      "erased type-only import",
      "scripts/reference.ts",
      ['import type { Command } from "./contracts";'],
      "DECLARATION_ONLY_IMPORT",
    ],
    [
      "unsupported-language fixed data",
      "src/core/frame.rs",
      ["const FRAME_LIMIT: usize = 64;"],
      "FIXED_DATA_DECLARATION",
    ],
    ["empty executable scope", "README.md", ["documentation only"], "no executable statement"],
  ];

  for (const [label, file, added, reason] of completelyClassified) {
    it(`merges ${label} because its exact bounded class is complete`, () => {
      const diffPatch = patchFor(file, added);
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAdequacy).toMatchObject({
        conclusion: "ABSENCE_ESTABLISHED",
        completeness: "COMPLETE",
      });
      expect(discovery.scopeAdequacy.evidence.join(" ")).toContain(reason);
      const obligations = assuranceObligationsFor(
        report(),
        correctnessOnlyPlan,
        bindingFor(diffPatch),
      );
      expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
        status: "PASS",
        material: true,
      });
      expect(
        deriveTrustState(
          "VERIFIED",
          report(),
          correctnessOnlyPlan,
          undefined,
          bindingFor(diffPatch),
        ),
      ).toBe("MERGE_ELIGIBLE");
    });
  }

  const benignSensitiveUses: Array<[string, string[]]> = [
    ["length", ["const p = await getpass('pin');", "const present = p.length > 0;"]],
    ["comparison", ["const p = await getpass('pin');", "const same = expected === p;"]],
    ["boolean", ["const p = await getpass('pin');", "if (p) {", "}"]],
  ];

  for (const [label, added] of benignSensitiveUses) {
    it(`keeps completely classified local sensitive ${label} progressive`, () => {
      const diffPatch = patchFor(`src/core/${label}.ts`, added);
      const obligations = assuranceObligationsFor(
        report(),
        correctnessOnlyPlan,
        bindingFor(diffPatch),
      );
      expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")?.status).toBe("PASS");
      expect(
        obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW")),
      ).toMatchObject({ status: "PASS", material: true });
      expect(
        deriveTrustState(
          "VERIFIED",
          report(),
          correctnessOnlyPlan,
          undefined,
          bindingFor(diffPatch),
        ),
      ).toBe("MERGE_ELIGIBLE");
    });
  }

  it("does not treat an expansion-bearing exported template as fixed-data absence", () => {
    const diffPatch = patchFor("src/core/templates.ts", [
      `export const SHELL_TEMPLATE = "\${user.command}";`,
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.conclusion).toBe("INCOMPLETE");
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
    const obligation = assuranceObligationsFor(
      report(),
      correctnessOnlyPlan,
      bindingFor(diffPatch),
    ).find((item) => item.id === "DISCOVERY.ADEQUACY");
    expect(obligation).toMatchObject({ material: true, status: "NOT_CHECKED" });
  });

  it("keeps a preference-raised supported capability material alongside discovery adequacy", () => {
    const preferencePlan: AssurancePlan = {
      ...correctnessOnlyPlan,
      required: ["CORRECTNESS", "SECURITY"],
      notRequired: correctnessOnlyPlan.notRequired.filter((item) => item !== "SECURITY"),
      requirementOrigin: {
        CORRECTNESS: "CANDIDATE_EVIDENCE",
        SECURITY: "QUALITY_PREFERENCE",
      },
    };
    const diffPatch = patchFor("src/core/decision.ts", ["opaqueDecision(candidateInput);"]);
    const obligations = assuranceObligationsFor(report(), preferencePlan, bindingFor(diffPatch));
    expect(obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION")).toMatchObject({
      material: true,
      status: "NOT_CHECKED",
    });
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      material: true,
      status: "NOT_CHECKED",
    });
  });
});

describe("fixed-argument invocation contract", () => {
  const arbitraryInvocations: Array<[string, string]> = [
    ["zero-argument call", "initializeRuntime();"],
    ["fixed eval-shaped call", "eval('2 + 2');"],
    ["fixed exec-shaped call", "execSync('rm -rf /tmp/cache');"],
    ["fixed spawn-shaped call", "spawn('bash', ['-c', 'id']);"],
    ["fixed receiver call", "runtime.execute('/tmp/cache');"],
  ];

  for (const [label, statement] of arbitraryInvocations) {
    it(`records ${label} as fixed-argument metadata without establishing absence`, () => {
      const diffPatch = patchFor("src/core/invocation.ts", [statement]);
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAccounting).toMatchObject({
        totalRelevantUnits: 1,
        fixedArgumentInvocationUnits: 1,
        boundedClassifiedUnits: 0,
        unclassifiedRemainderUnits: 1,
        complete: false,
      });
      expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
      expect(
        assuranceObligationsFor(report(), correctnessOnlyPlan, bindingFor(diffPatch)).find(
          (item) => item.id === "DISCOVERY.ADEQUACY",
        ),
      ).toMatchObject({ status: "NOT_CHECKED", material: true });
      expect(
        deriveTrustState(
          "VERIFIED",
          report(),
          correctnessOnlyPlan,
          undefined,
          bindingFor(diffPatch),
        ),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("keeps harmless local scalar computation promotion-grade", () => {
    const discovery = discoverConcerns(
      patchFor("src/core/scalar.ts", ["const ok = left === right;"]),
    );
    expect(discovery.scopeAccounting).toMatchObject({
      boundedClassifiedUnits: 1,
      fixedArgumentInvocationUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("ABSENCE_ESTABLISHED");
  });

  it("keeps fixed data declaration promotion-grade", () => {
    const discovery = discoverConcerns(
      patchFor("src/core/constants.ts", ["const RETRY_LIMIT = 4;"]),
    );
    expect(discovery.scopeAccounting).toMatchObject({
      boundedClassifiedUnits: 1,
      fixedArgumentInvocationUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("ABSENCE_ESTABLISHED");
  });

  it("does not treat a runtime import as promotion-grade absence", () => {
    const discovery = discoverConcerns(
      patchFor("src/core/import.ts", ['import { initialize } from "./runtime";']),
    );
    expect(discovery.scopeAccounting).toMatchObject({
      boundedClassifiedUnits: 0,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
  });

  it("keeps an erased type-only import promotion-grade", () => {
    const discovery = discoverConcerns(
      patchFor("src/core/types.ts", ['import type { Request } from "./contracts";']),
    );
    expect(discovery.scopeAccounting).toMatchObject({
      boundedClassifiedUnits: 1,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(discovery.scopeAdequacy.conclusion).toBe("ABSENCE_ESTABLISHED");
  });
});

describe("candidate, ledger, and downstream parity", () => {
  it("uses one candidate/digest-bound obligation set for decision and ledger", () => {
    const diffPatch = patchFor("src/core/gap.ts", ["opaqueBoundary(candidateInput);"]);
    const binding = bindingFor(diffPatch);
    const obligations = assuranceObligationsFor(report(), correctnessOnlyPlan, binding);
    expect(
      obligations.every(
        (item) =>
          item.candidateId === binding.candidateId && item.diffDigest === binding.diffDigest,
      ),
    ).toBe(true);
    expect(unresolvedObligations(obligations).map((item) => item.id)).toContain(
      "DISCOVERY.ADEQUACY",
    );
    expect(deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, binding)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });

  it("MissionTree rejects the exact discovery-blocked trust result without a special case", () => {
    const diffPatch = patchFor("src/core/gap.ts", ["opaqueBoundary(candidateInput);"]);
    const trustState = deriveTrustState(
      "VERIFIED",
      report(),
      correctnessOnlyPlan,
      undefined,
      bindingFor(diffPatch),
    );
    const node: MissionNode = {
      id: "root",
      dependencyIds: [],
      state: "READY",
      executionMode: "GUIDED",
      agent: "fixture",
      model: "fixture",
      budget: 1,
      inputs: [],
      outputs: [],
      verificationState: "VERIFIED",
      trustState,
    };
    expect(() => new MissionTree(node).promote("root", "artifact")).toThrow(/not MERGE_ELIGIBLE/u);
  });
});

const fixtures: FixtureRepository[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

const alwaysVerified: VerifierPort = {
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

describe("live RunService composition", () => {
  it("blocks planner-missed discovery incompleteness and emits the same delivery contract", async () => {
    const fixture = await createFixtureRepository();
    fixtures.push(fixture);
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
        capabilities: { livePolicyUpdate: true },
      }) as AgentAdapter,
      sandbox: new LocalWorktreeSandbox("", "none"),
      verifier: alwaysVerified,
      repositoryIndex: new LocalRepositoryIndex(),
      projectBrain: brain,
      contextBuilder: new GuidedContextBuilder(brain),
      telemetry: new DomainTelemetryRecorder(),
      runtimeSignals: new EvidenceRuntimeSignalCollector(),
    });
    const created = await service.create({
      prompt: "write neutral discovery gap",
      repositoryPath: fixture.path,
      verification: { command: "echo ok" },
    });
    const completed = await waitFor(
      () => service.get(created.id),
      (run) => run?.state === "COMPLETED" || run?.state === "FAILED",
    );
    await service.waitForIdle(created.id);
    expect(completed?.verificationState).toBe("VERIFIED");
    expect(completed?.trustState).toBe("CORRECTNESS_VERIFIED");

    const events = await service.events(created.id);
    const diffPlan = events.find(
      (event) =>
        event.type === "AssurancePlanned" &&
        (event.data as { stage?: string }).stage === "diff-captured",
    )?.data as { plan?: { required: string[] } } | undefined;
    expect(diffPlan?.plan?.required).not.toContain("SECURITY");

    const quality = events.find((event) => event.type === "QualityAssessed")?.data as
      | {
          candidateId?: string;
          diffDigest?: string;
          obligations?: Array<Record<string, unknown>>;
          unresolvedObligations?: string[];
        }
      | undefined;
    expect(quality?.obligations).toContainEqual(
      expect.objectContaining({
        id: "DISCOVERY.ADEQUACY",
        material: true,
        status: "NOT_CHECKED",
        candidateId: quality?.candidateId,
        diffDigest: quality?.diffDigest,
      }),
    );
    expect(quality?.unresolvedObligations).toContain("DISCOVERY.ADEQUACY");

    const delivery = await service.delivery(created.id);
    expect(delivery).toMatchObject({
      handoff: {
        candidateId: quality?.candidateId,
        candidateDigest: quality?.diffDigest,
        trustState: "CORRECTNESS_VERIFIED",
      },
      candidateQuality: "BLOCKED",
      mergeEligibility: "BLOCKED",
      autoMergeAllowed: false,
    });
  }, 60_000);
});
