import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import {
  assuranceObligationsFor,
  deriveTrustState,
  type QualityReport,
} from "../src/domain/quality";

const patchFor = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

const removalPatchFor = (file: string, removed: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ /dev/null`,
    `@@ -1,${removed.length} +0,0 @@`,
    ...removed.map((line) => `-${line}`),
  ].join("\n");

const replacementPatchFor = (file: string, removed: string[], added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

const check = (
  state: QualityReport["Security"]["state"],
  coverage: QualityReport["Security"]["coverage"] = "FULL",
): QualityReport["Security"] => ({
  state,
  evidence: ["exact concern coverage fixture"],
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

const allChecks: AssurancePlan["required"] = [
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
  notRequired: allChecks.filter((item) => item !== "CORRECTNESS"),
  reasons: Object.fromEntries(
    allChecks.map((item) => [item, "exact concern coverage fixture"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};

const trustFactsFor = (diffPatch: string) => {
  const binding = {
    candidateId: "candidate-exact-coverage",
    diffDigest: "digest-exact-coverage",
    diffPatch,
    qualityPreference: "BALANCED" as const,
  };
  const discovery = discoverConcerns(diffPatch);
  const obligations = assuranceObligationsFor(report(), correctnessOnlyPlan, binding);
  return {
    discovery,
    discoveryObligation: obligations.find((item) => item.id === "DISCOVERY.ADEQUACY"),
    typedConcernObligations: obligations.filter((item) =>
      discovery.concerns.some((concern) => item.id.startsWith(concern.concern)),
    ),
    trustState: deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, binding),
  };
};

const expectPartialConcernUnit = (diffPatch: string): void => {
  const facts = trustFactsFor(diffPatch);
  expect(facts.discovery.scopeAccounting).toMatchObject({
    totalRelevantUnits: 1,
    concernAttributedUnits: 1,
    concernCoveredUnits: 0,
    partiallyConcernCoveredUnits: 1,
    unsupportedUnits: 0,
    unclassifiedRemainderUnits: 1,
    complete: false,
  });
  expect(facts.discovery.scopeAdequacy).toMatchObject({
    conclusion: "INCOMPLETE",
    completeness: "INCOMPLETE",
    coverage: "PARTIAL",
  });
  expect(facts.discoveryObligation).toMatchObject({
    status: "NOT_CHECKED",
    material: true,
  });
  expect(facts.typedConcernObligations).toContainEqual(
    expect.objectContaining({
      id: expect.stringMatching(/^SECURITY\.SENSITIVE_INPUT_FLOW/),
      status: "NOT_CHECKED",
      material: true,
    }),
  );
  expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
};

describe("full concern coverage requires full expression coverage", () => {
  const composedExpressions = [
    "flag && getpass('pin')",
    "flag || getpass('pin')",
    "flag ?? getpass('pin')",
    "cond ? fallback : getpass('pin')",
    "x + getpass('pin')",
    "!getpass('pin')",
    "void getpass('pin')",
    "typeof getpass('pin')",
  ];

  for (const expression of composedExpressions) {
    it(`keeps the residual expression region for ${expression}`, () => {
      expectPartialConcernUnit(patchFor("src/session/composed.ts", [`const p = ${expression};`]));
    });
  }

  it("preserves an allowed await wrapper around one true direct call", () => {
    const facts = trustFactsFor(
      patchFor("src/session/direct.ts", ["const p = await getpass('pin');"]),
    );
    expect(facts.discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      concernAttributedUnits: 1,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "CONCERNS_FOUND",
      completeness: "NOT_APPLICABLE",
      coverage: "FULL",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "PASS",
      material: true,
    });
    expect(facts.typedConcernObligations).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^SECURITY\.SENSITIVE_INPUT_FLOW/),
        status: "PASS",
        material: true,
      }),
    );
    expect(facts.trustState).toBe("MERGE_ELIGIBLE");
  });
});

describe("source-call arguments remain part of the changed unit", () => {
  const opaqueArguments = [
    "(ALLOWED = ['*'], 'pin')",
    "module.exports = { open: true }",
    "(y = 1, 'pin')",
    "{ shell: true, command: request }",
  ];

  for (const argument of opaqueArguments) {
    it(`keeps argument evaluation residual for ${argument}`, () => {
      expectPartialConcernUnit(
        patchFor("src/session/argument.ts", [`const p = getpass(${argument});`]),
      );
    });
  }
});

describe("concern attribution composes conservatively", () => {
  it("does not let a later FULL authorization attribution erase an earlier PARTIAL flow region", () => {
    const facts = trustFactsFor(
      patchFor("src/session/composition.ts", [
        "const permission = getpass('pin');",
        "const allowed = [permission].length > 0;",
      ]),
    );
    expect(facts.discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernAttributedUnits: 2,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 1,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "INCOMPLETE",
      completeness: "INCOMPLETE",
      coverage: "PARTIAL",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "NOT_CHECKED",
      material: true,
    });
    expect(facts.typedConcernObligations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringMatching(/^SECURITY\.SENSITIVE_INPUT_FLOW/),
          status: "NOT_CHECKED",
          material: true,
        }),
        expect.objectContaining({
          id: expect.stringMatching(/^SECURITY\.AUTHORIZATION_BEHAVIOR/),
          status: "NOT_CHECKED",
          material: true,
        }),
      ]),
    );
    expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("numeric promotion authority follows declaration syntax", () => {
  const bareAssignments: Array<[string, string, string]> = [
    ["JavaScript", "src/config/limits.js", "REQUIRED_APPROVALS = 0;"],
    ["TypeScript", "src/config/session.ts", "SESSION_TTL = 999999999;"],
  ];

  for (const [label, file, statement] of bareAssignments) {
    it(`does not treat a bare uppercase ${label} assignment as a declaration`, () => {
      const facts = trustFactsFor(patchFor(file, [statement]));
      expect(facts.discovery.scopeAccounting).toMatchObject({
        totalRelevantUnits: 1,
        concernAttributedUnits: 0,
        concernCoveredUnits: 0,
        partiallyConcernCoveredUnits: 0,
        syntaxClassifiedUnits: 0,
        promotionAbsenceEstablishedUnits: 0,
        unsupportedUnits: 0,
        unclassifiedRemainderUnits: 1,
        complete: false,
      });
      expect(facts.discovery.scopeAdequacy).toMatchObject({
        conclusion: "INCOMPLETE",
        coverage: "PARTIAL",
      });
      expect(facts.discoveryObligation).toMatchObject({
        status: "NOT_CHECKED",
        material: true,
      });
      expect(facts.typedConcernObligations).toEqual([]);
      expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("keeps removed and replaced JavaScript bare assignments outside declaration authority", () => {
    for (const diffPatch of [
      removalPatchFor("src/config/limits.js", ["REQUIRED_APPROVALS = 1;"]),
      replacementPatchFor(
        "src/config/limits.js",
        ["REQUIRED_APPROVALS = 1;"],
        ["REQUIRED_APPROVALS = 0;"],
      ),
    ]) {
      const facts = trustFactsFor(diffPatch);
      expect(facts.discovery.scopeAccounting).toMatchObject({
        concernAttributedUnits: 0,
        concernCoveredUnits: 0,
        partiallyConcernCoveredUnits: 0,
        syntaxClassifiedUnits: 0,
        promotionAbsenceEstablishedUnits: 0,
        unsupportedUnits: 0,
        complete: false,
      });
      expect(facts.discovery.scopeAccounting.unclassifiedRemainderUnits).toBe(
        facts.discovery.scopeAccounting.totalRelevantUnits,
      );
      expect(facts.discovery.scopeAdequacy).toMatchObject({
        conclusion: "INCOMPLETE",
        coverage: "PARTIAL",
      });
      expect(facts.discoveryObligation).toMatchObject({
        status: "NOT_CHECKED",
        material: true,
      });
      expect(facts.typedConcernObligations).toEqual([]);
      expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
    }
  });

  const progressiveDeclarations: Array<[string, string, string]> = [
    ["JavaScript const", "src/config/limits.js", "const REQUIRED_APPROVALS = 0;"],
    ["Python binding", "src/config/limits.py", "REQUIRED_APPROVALS = 0"],
    ["Go const", "src/config/limits.go", "const RequiredApprovals = 0"],
  ];

  for (const [label, file, statement] of progressiveDeclarations) {
    it(`preserves ${label} declaration progression`, () => {
      const facts = trustFactsFor(patchFor(file, [statement]));
      expect(facts.discovery.scopeAccounting).toMatchObject({
        totalRelevantUnits: 1,
        concernAttributedUnits: 0,
        concernCoveredUnits: 0,
        partiallyConcernCoveredUnits: 0,
        syntaxClassifiedUnits: 1,
        promotionAbsenceEstablishedUnits: 1,
        unsupportedUnits: 0,
        unclassifiedRemainderUnits: 0,
        complete: true,
      });
      expect(facts.discovery.scopeAdequacy).toMatchObject({
        conclusion: "ABSENCE_ESTABLISHED",
        completeness: "COMPLETE",
        coverage: "FULL",
      });
      expect(facts.discoveryObligation).toMatchObject({
        status: "PASS",
        material: true,
      });
      expect(facts.typedConcernObligations).toEqual([]);
      expect(facts.trustState).toBe("MERGE_ELIGIBLE");
    });
  }

  it("does not promote removal or replacement from the added declaration alone", () => {
    for (const diffPatch of [
      removalPatchFor("src/config/limits.ts", ["const REQUIRED_APPROVALS = 1;"]),
      replacementPatchFor(
        "src/config/limits.ts",
        ["const REQUIRED_APPROVALS = 1;"],
        ["const REQUIRED_APPROVALS = 0;"],
      ),
    ]) {
      const facts = trustFactsFor(diffPatch);
      expect(facts.discovery.scopeAccounting.syntaxClassifiedUnits).toBe(
        facts.discovery.scopeAccounting.totalRelevantUnits,
      );
      expect(facts.discovery.scopeAccounting.unclassifiedRemainderUnits).toBe(1);
      expect(facts.discovery.scopeAccounting.complete).toBe(false);
      expect(facts.discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
      expect(facts.discoveryObligation).toMatchObject({
        status: "NOT_CHECKED",
        material: true,
      });
      expect(facts.typedConcernObligations).toEqual([]);
      expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
    }
  });
});

describe("inspectable executable-capable formats remain in scope", () => {
  it("keeps executable MDX bytes visible and unsupported", () => {
    const facts = trustFactsFor(
      patchFor("pages/x.mdx", ["export const run = (c) => execSync(c.cmd);"]),
    );
    expect(facts.discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      concernAttributedUnits: 1,
      concernCoveredUnits: 0,
      partiallyConcernCoveredUnits: 1,
      unsupportedUnits: 1,
      unclassifiedRemainderUnits: 0,
      complete: false,
    });
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "INCOMPLETE",
      completeness: "INCOMPLETE",
      coverage: "UNSUPPORTED",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "UNSUPPORTED",
      material: true,
    });
    expect(facts.typedConcernObligations).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^SECURITY\.SUBPROCESS_EXECUTION/),
        status: "NOT_CHECKED",
        material: true,
      }),
    );
    expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
  });

  it("keeps SVG script/event bytes visible and unsupported", () => {
    const facts = trustFactsFor(
      patchFor("assets/action.svg", [
        '<svg onload="launch(request.command)"><script>launch(request.command)</script></svg>',
      ]),
    );
    expect(facts.discovery.scopeAccounting.totalRelevantUnits).toBeGreaterThan(0);
    expect(facts.discovery.scopeAccounting.concernCoveredUnits).toBe(0);
    expect(facts.discovery.scopeAccounting.unsupportedUnits).toBeGreaterThan(0);
    expect(facts.discovery.scopeAccounting.unclassifiedRemainderUnits).toBe(0);
    expect(facts.discovery.scopeAccounting.complete).toBe(false);
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "INCOMPLETE",
      completeness: "INCOMPLETE",
      coverage: "UNSUPPORTED",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "UNSUPPORTED",
      material: true,
    });
    expect(facts.typedConcernObligations).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^SECURITY\.SUBPROCESS_EXECUTION/),
        status: "NOT_CHECKED",
        material: true,
      }),
    );
    expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
  });

  it("keeps unsupported inspectable hybrid content explicit", () => {
    const facts = trustFactsFor(
      patchFor("components/action.component", ["<Action handler={request.command} />"]),
    );
    expect(facts.discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      concernAttributedUnits: 0,
      concernCoveredUnits: 0,
      partiallyConcernCoveredUnits: 0,
      unsupportedUnits: 1,
      unclassifiedRemainderUnits: 0,
      complete: false,
    });
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "INCOMPLETE",
      completeness: "INCOMPLETE",
      coverage: "UNSUPPORTED",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "UNSUPPORTED",
      material: true,
    });
    expect(facts.typedConcernObligations).toEqual([]);
    expect(facts.trustState).toBe("CORRECTNESS_VERIFIED");
  });

  it("preserves ordinary Markdown prose as empty documentation scope", () => {
    const facts = trustFactsFor(
      patchFor("docs/guide.md", ["This guide explains how approval limits are reviewed."]),
    );
    expect(facts.discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 0,
      concernAttributedUnits: 0,
      concernCoveredUnits: 0,
      partiallyConcernCoveredUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(facts.discovery.scopeAdequacy).toMatchObject({
      conclusion: "ABSENCE_ESTABLISHED",
      completeness: "COMPLETE",
      coverage: "NOT_APPLICABLE",
    });
    expect(facts.discoveryObligation).toMatchObject({
      status: "PASS",
      material: true,
    });
    expect(facts.typedConcernObligations).toEqual([]);
    expect(facts.trustState).toBe("MERGE_ELIGIBLE");
  });
});
