import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import {
  classifyBoundedDiscoveryStatement,
  declarationLanguageOf,
} from "../src/domain/local-code-semantics";
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
  evidence: ["within-unit trust fixture"],
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
    allChecks.map((item) => [item, "within-unit trust fixture"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};

const bindingFor = (diffPatch: string) => ({
  candidateId: "candidate-within-unit",
  diffDigest: "digest-within-unit",
  diffPatch,
  qualityPreference: "BALANCED" as const,
});

const trustFor = (diffPatch: string) =>
  deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, undefined, bindingFor(diffPatch));

const obligationsFor = (diffPatch: string) =>
  assuranceObligationsFor(report(), correctnessOnlyPlan, bindingFor(diffPatch));

const discoveryObligationFor = (diffPatch: string) =>
  obligationsFor(diffPatch).find((item) => item.id === "DISCOVERY.ADEQUACY");

const flowObligationFor = (diffPatch: string) =>
  obligationsFor(diffPatch).find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));

describe("within-statement concern coverage", () => {
  it("leaves an opaque sibling call residual after a known-local sensitive observation", () => {
    const diffPatch = patchFor("src/core/mixed.ts", [
      "const p = await getpass('pin');",
      "const present =",
      "  p.length > 0 &&",
      "  dispatchPrepared(request.payload);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.concerns.map((item) => item.concern)).toContain(
      "SECURITY.SENSITIVE_INPUT_FLOW",
    );
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernAttributedUnits: 2,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 1,
      promotionAbsenceEstablishedUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discoveryObligationFor(diffPatch)).toMatchObject({
      status: "NOT_CHECKED",
      material: true,
    });
    expect(flowObligationFor(diffPatch)).toMatchObject({
      status: "PASS",
      material: true,
    });
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });

  it("does not let a concern-related comma declaration cover an unrelated call", () => {
    const diffPatch = patchFor("src/core/comma-use.ts", [
      "const p = await getpass('pin');",
      "const present = p.length > 0, ignored = dispatchPrepared(request.payload);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernAttributedUnits: 2,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 1,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });

  it("keeps an opaque sibling and a later derived-alias use outside proven alias coverage", () => {
    const diffPatch = patchFor("src/core/alias-gap.ts", [
      "const p = await getpass('pin');",
      "const present = p.length > 0 && dispatchPrepared(request.payload);",
      "send(present);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 3,
      concernAttributedUnits: 2,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 1,
      unclassifiedRemainderUnits: 2,
      complete: false,
    });
    expect(flowObligationFor(diffPatch)).toMatchObject({
      status: "PASS",
      material: true,
    });
    expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });

  it("reproduces the unrecognized execution-boundary false-safe as residual scope", () => {
    const diffPatch = patchFor("src/core/exec.ts", [
      "const p = await getpass('pin');",
      "const present =",
      "  p.length > 0 &&",
      "  require('child_process').execFile(",
      "    '/bin/sh',",
      "    ['-c', request.payload]",
      "  );",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.concerns.map((item) => item.concern)).toEqual([
      "SECURITY.SENSITIVE_INPUT_FLOW",
    ]);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 1,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
    expect(flowObligationFor(diffPatch)?.status).toBe("PASS");
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });

  it("does not parse a same-statement origin and comma sibling as one direct source", () => {
    const diffPatch = patchFor("src/core/comma-origin.ts", [
      "const p = await getpass('pin'), ignored = dispatchPrepared(request.payload);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      concernAttributedUnits: 1,
      concernCoveredUnits: 0,
      partiallyConcernCoveredUnits: 1,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(flowObligationFor(diffPatch)).toMatchObject({
      status: "NOT_CHECKED",
      material: true,
    });
    expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });

  it("allows a fully concern-covered direct origin with no residual", () => {
    const diffPatch = patchFor("src/core/origin.ts", ["const p = await getpass('pin');"]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 1,
      concernAttributedUnits: 1,
      concernCoveredUnits: 1,
      partiallyConcernCoveredUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(discoveryObligationFor(diffPatch)?.status).toBe("PASS");
    expect(flowObligationFor(diffPatch)?.status).toBe("PASS");
    expect(trustFor(diffPatch)).toBe("MERGE_ELIGIBLE");
  });

  it("continues to block a fully covered concern plus a separate opaque statement", () => {
    const diffPatch = patchFor("src/core/separate.ts", [
      "const p = await getpass('pin');",
      "dispatchPrepared(request.payload);",
    ]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 2,
      concernCoveredUnits: 1,
      unclassifiedRemainderUnits: 1,
      complete: false,
    });
    expect(flowObligationFor(diffPatch)?.status).toBe("PASS");
    expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
    expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("bounded classifier claim authority", () => {
  const nonPromoting: Array<[string, string, string, string]> = [
    [
      "exported literal collection",
      "src/core/roles.ts",
      'export const ALLOWED_ROLES = ["*"];',
      "FIXED_DATA_DECLARATION",
    ],
    [
      "exported policy boolean",
      "src/core/policy.ts",
      "export const REQUIRE_ADMIN = false;",
      "FIXED_DATA_DECLARATION",
    ],
    [
      "exported policy string",
      "src/core/mode.ts",
      'export const AUTH_MODE = "open";',
      "FIXED_DATA_DECLARATION",
    ],
    [
      "string concatenation",
      "src/core/command.ts",
      'const assembled = "rm -rf " + dir;',
      "LOCAL_SCALAR_COMPUTATION",
    ],
    [
      "query concatenation",
      "src/core/query.ts",
      'const assembled = "SELECT * FROM users WHERE id = " + userId;',
      "LOCAL_SCALAR_COMPUTATION",
    ],
    ["regex literal", "src/core/route.ts", "const pattern = /.*/;", "UNCLASSIFIED"],
  ];

  for (const [label, file, statement, expectedClass] of nonPromoting) {
    it(`keeps ${label} syntax metadata separate from promotion absence`, () => {
      expect(
        classifyBoundedDiscoveryStatement(statement, declarationLanguageOf(file)) ?? "UNCLASSIFIED",
      ).toBe(expectedClass);
      const diffPatch = patchFor(file, [statement]);
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAccounting).toMatchObject({
        totalRelevantUnits: 1,
        syntaxClassifiedUnits: expectedClass === "UNCLASSIFIED" ? 0 : 1,
        promotionAbsenceEstablishedUnits: 0,
        unclassifiedRemainderUnits: 1,
        complete: false,
      });
      expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
      expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("does not promote removal or replacement of fixed policy data", () => {
    for (const diffPatch of [
      removalPatchFor("src/core/policy.ts", ["const REQUIRE_ADMIN = true;"]),
      replacementPatchFor(
        "src/core/policy.ts",
        ["const REQUIRE_ADMIN = true;"],
        ["const REQUIRE_ADMIN = false;"],
      ),
    ]) {
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAccounting.syntaxClassifiedUnits).toBeGreaterThan(0);
      expect(discovery.scopeAccounting.promotionAbsenceEstablishedUnits).toBe(0);
      expect(discovery.scopeAccounting.unclassifiedRemainderUnits).toBe(
        discovery.scopeAccounting.totalRelevantUnits,
      );
      expect(discovery.scopeAccounting.complete).toBe(false);
      expect(discoveryObligationFor(diffPatch)?.status).toBe("NOT_CHECKED");
      expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
    }
  });

  const progressive: Array<[string, string, string, string]> = [
    [
      "plain numeric constant",
      "src/core/constants.ts",
      "const RETRY_LIMIT = 4;",
      "FIXED_DATA_DECLARATION",
    ],
    [
      "pure local scalar",
      "src/core/math.ts",
      "const total = subtotal + tax;",
      "LOCAL_SCALAR_COMPUTATION",
    ],
    [
      "harmless comparison",
      "src/core/compare.ts",
      "const ok = left === right;",
      "LOCAL_SCALAR_COMPUTATION",
    ],
  ];

  for (const [label, file, statement, expectedClass] of progressive) {
    it(`keeps ${label} progressive under its narrower promotion claim`, () => {
      expect(classifyBoundedDiscoveryStatement(statement, declarationLanguageOf(file))).toBe(
        expectedClass,
      );
      const diffPatch = patchFor(file, [statement]);
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAccounting).toMatchObject({
        totalRelevantUnits: 1,
        syntaxClassifiedUnits: 1,
        promotionAbsenceEstablishedUnits: 1,
        unclassifiedRemainderUnits: 0,
        complete: true,
      });
      expect(discoveryObligationFor(diffPatch)?.status).toBe("PASS");
      expect(trustFor(diffPatch)).toBe("MERGE_ELIGIBLE");
    });
  }
});

describe("opaque scope survives convenience path filtering", () => {
  const gitlinkPatch = (file: string): string =>
    [
      `diff --git a/${file} b/${file}`,
      "index 1111111..2222222 160000",
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      "-Subproject commit 1111111111111111111111111111111111111111",
      "+Subproject commit 2222222222222222222222222222222222222222",
    ].join("\n");

  const binaryPatch = (file: string): string =>
    [
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      "index 0000000..1234567",
      "GIT binary patch",
      "literal 4",
      "Lc${NkU|;|M00aO5",
    ].join("\n");

  const renamePatch = [
    "diff --git a/vendor/old.bin b/vendor/new.bin",
    "similarity index 100%",
    "rename from vendor/old.bin",
    "rename to vendor/new.bin",
  ].join("\n");

  for (const [label, diffPatch] of [
    ["normal-path gitlink", gitlinkPatch("modules/runtime")],
    ["vendor-path gitlink", gitlinkPatch("vendor/runtime")],
    ["excluded-looking binary", binaryPatch("vendor/generated/blob.bin")],
    ["rename without inspectable body", renamePatch],
  ] as const) {
    it(`represents ${label} as unsupported material scope`, () => {
      const discovery = discoverConcerns(diffPatch);
      expect(discovery.scopeAccounting.totalRelevantUnits).toBeGreaterThan(0);
      expect(discovery.scopeAccounting.unsupportedUnits).toBeGreaterThan(0);
      expect(discovery.scopeAccounting.complete).toBe(false);
      expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
      expect(discoveryObligationFor(diffPatch)?.status).toBe("UNSUPPORTED");
      expect(trustFor(diffPatch)).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("still treats ordinary documentation text as truly non-executable scope", () => {
    const diffPatch = patchFor("docs/guide.md", ["Documentation only."]);
    const discovery = discoverConcerns(diffPatch);
    expect(discovery.scopeAccounting).toMatchObject({
      totalRelevantUnits: 0,
      unsupportedUnits: 0,
      unclassifiedRemainderUnits: 0,
      complete: true,
    });
    expect(discovery.scopeAdequacy).toMatchObject({
      conclusion: "ABSENCE_ESTABLISHED",
      coverage: "NOT_APPLICABLE",
    });
    expect(trustFor(diffPatch)).toBe("MERGE_ELIGIBLE");
  });
});
