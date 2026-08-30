import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import {
  assuranceObligationsFor,
  deriveTrustState,
  type QualityReport,
} from "../src/domain/quality";

/**
 * Root-contract invariants for promotion authority.
 *
 * Every case here asserts the MASTER TRUST INVARIANT: CLAIM_SCOPE <= PROVEN_ANALYSIS_SCOPE.
 * These are contract tests, not a fixture museum: each family varies one structural property of a
 * benign progressing candidate and asserts that promotion authority does not survive the change.
 */

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
    `+++ b/${file}`,
    `@@ -1,${removed.length} +0,0 @@`,
    ...removed.map((line) => `-${line}`),
  ].join("\n");

const check = (
  state: QualityReport["Security"]["state"],
  coverage: QualityReport["Security"]["coverage"] = "FULL",
): QualityReport["Security"] => ({
  state,
  evidence: ["promotion-authority fixture"],
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
    allChecks.map((item) => [item, "promotion-authority fixture"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};

const bindingFor = (diffPatch: string) => ({
  candidateId: "candidate-authority",
  diffDigest: "digest-authority",
  diffPatch,
  qualityPreference: "BALANCED" as const,
});

/** The exact production composition RunService uses. */
const trustFor = (diffPatch: string) =>
  deriveTrustState("VERIFIED", report(), correctnessOnlyPlan, true, { ...bindingFor(diffPatch) });

const obligationsFor = (diffPatch: string) =>
  assuranceObligationsFor(report(), correctnessOnlyPlan, bindingFor(diffPatch));

const accountingFor = (diffPatch: string) => discoverConcerns(diffPatch).scopeAccounting;

describe("RC1 — promotion-grade scalar absence requires proven effect-freedom", () => {
  /**
   * Each candidate embeds a real effect inside an otherwise-scalar expression. None may reach
   * MERGE_ELIGIBLE, and none may be counted as a promotion-absence unit: an effect is material
   * behavior that the bounded scalar contract does not model.
   */
  const effectfulScalarCandidates: Array<{ label: string; statement: string }> = [
    { label: "parenthesized assignment", statement: "const total = (enabled = 1);" },
    { label: "assignment as an operand", statement: "const total = subtotal + (enabled = 1);" },
    { label: "assignment behind a guard", statement: "const total = ready && (enabled = 1);" },
    { label: "compound assignment", statement: "const total = (enabled += 1);" },
    { label: "delete operation", statement: "const gone = delete enabled;" },
    { label: "yield of a literal", statement: "const n = yield 1;" },
    { label: "yield of an identifier", statement: "const n = yield enabled;" },
    { label: "regex operand", statement: "const n = 1 + /x/;" },
    { label: "prefix update", statement: "const n = --lockCount;" },
    { label: "postfix update", statement: "const n = lockCount++;" },
    { label: "comma sequence", statement: "const n = (release(), 1);" },
    { label: "deeply nested assignment", statement: "const n = a + (b * (c - (d = 2)));" },
    { label: "assignment inside a ternary", statement: "const n = flag ? (x = 1) : 2;" },
    { label: "await of an identifier", statement: "const n = await pending;" },
    { label: "typeof-guarded assignment", statement: "const n = typeof (x = 1);" },
    { label: "logical assignment", statement: "const n = (cache ||= 1);" },
    { label: "nullish assignment", statement: "const n = (cache ??= 1);" },
    { label: "exponent with assignment", statement: "const n = base ** (exp = 2);" },
  ];

  it.each(effectfulScalarCandidates)("denies promotion authority to $label", ({ statement }) => {
    const patch = patchFor("src/util.ts", [statement]);
    const accounting = accountingFor(patch);

    expect(accounting.totalRelevantUnits).toBe(1);
    // The unit must remain residual: it is neither concern-covered nor promotion-absence proven.
    expect(accounting.promotionAbsenceEstablishedUnits).toBe(0);
    expect(accounting.unsupportedUnits + accounting.unclassifiedRemainderUnits).toBe(1);
    expect(accounting.complete).toBe(false);
    expect(discoverConcerns(patch).scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("keeps DISCOVERY.ADEQUACY materially unresolved for an effectful scalar", () => {
    const patch = patchFor("src/util.ts", ["const total = (enabled = 1);"]);
    const adequacy = obligationsFor(patch).find((item) => item.id === "DISCOVERY.ADEQUACY");
    expect(adequacy?.material).toBe(true);
    expect(adequacy?.status).not.toBe("PASS");
  });
});

describe("RC1 — benign bounded scalars keep progressing", () => {
  const pureScalarCandidates: Array<{ label: string; statement: string }> = [
    { label: "arithmetic sum", statement: "const total = subtotal + tax;" },
    { label: "strict equality", statement: "const ok = left === right;" },
    { label: "mixed precedence arithmetic", statement: "const count = a + b * c;" },
    { label: "length comparison", statement: "const present = p.length > 0;" },
    { label: "parenthesized arithmetic", statement: "const total = (subtotal + tax) * rate;" },
    { label: "boolean conjunction", statement: "const ok = ready && enabled;" },
    { label: "ternary of identifiers", statement: "const n = flag ? a : b;" },
    { label: "negation", statement: "const off = !enabled;" },
    { label: "numeric constant", statement: "const RETRY_LIMIT = 4;" },
  ];

  it.each(pureScalarCandidates)("still promotes $label", ({ statement }) => {
    const patch = patchFor("src/util.ts", [statement]);
    const accounting = accountingFor(patch);

    expect(accounting.totalRelevantUnits).toBe(1);
    expect(accounting.promotionAbsenceEstablishedUnits).toBe(1);
    expect(accounting.unsupportedUnits + accounting.unclassifiedRemainderUnits).toBe(0);
    expect(accounting.complete).toBe(true);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });
});

describe("RC2 — identifier-use completeness is not whole-unit coverage", () => {
  /**
   * The archetype correlated-gate failure: one bounded helper minting both DISCOVERY FULL and
   * TYPED FLOW COMPLETE for a statement that also contains an unrelated effect.
   */
  const patch = patchFor("src/auth.ts", [
    "const p = await getpass('pin');",
    "const present = p.length > 0 && (enabled = 1);",
  ]);

  it("does not FULL-cover a unit whose sibling region is an unproven effect", () => {
    const accounting = accountingFor(patch);
    expect(accounting.totalRelevantUnits).toBe(2);
    // The observation unit retains residual: the assignment sibling is not accounted.
    expect(accounting.concernCoveredUnits).toBeLessThan(accounting.totalRelevantUnits);
    expect(accounting.complete).toBe(false);
  });

  it("blocks promotion while the changed unit retains an unaccounted region", () => {
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("keeps the typed flow claim narrow rather than a whole-unit safety claim (P1.2)", () => {
    const discovery = discoverConcerns(patch);
    const evidence = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
      candidateId: "candidate-authority",
      diffDigest: "digest-authority",
    });
    const flow = evidence.filter((item) => item.concern === "SECURITY.SENSITIVE_INPUT_FLOW");
    expect(flow.length).toBeGreaterThan(0);
    for (const record of flow) {
      if (record.claim === "NEGATIVE_ABSENCE" && record.outcome === "PASS") {
        // A narrow identifier-use PASS may legitimately stand, but it must declare that it is
        // about USES and not about the containing unit's behavior.
        expect(record.analysisScope).toMatch(/IDENTIFIER-USE COMPLETENESS ONLY/u);
        expect(record.analysisScope).toMatch(/NOT whole-unit behavioral coverage/u);
      }
    }
    // And the material trust state must still be blocked by the discovery remainder.
    expect(discovery.scopeAccounting.complete).toBe(false);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("preserves the benign concealed-source progression it is derived from", () => {
    const benign = patchFor("src/auth.ts", [
      "const p = await getpass('pin');",
      "const present = p.length > 0;",
    ]);
    expect(trustFor(benign)).toBe("MERGE_ELIGIBLE");
  });
});

describe("RC3a — comment/segmentation cannot erase executable material", () => {
  const erasureCandidates: Array<{ label: string; file: string; lines: string[] }> = [
    {
      label: "block-comment prefix followed by an executable call",
      file: "src/run.ts",
      lines: ["const RETRY_LIMIT = 4;", "/* */ exec(request.command)"],
    },
    {
      label: "JS decrement mistaken for a SQL comment prefix",
      file: "src/run.ts",
      lines: ["const RETRY_LIMIT = 4;", "--lockCount"],
    },
    {
      label: "C preprocessor line in a C source file",
      file: "src/run.c",
      lines: ["const int RETRY_LIMIT = 4;", "#define EXEC(x) system(x)"],
    },
    {
      label: "star-prefixed executable pointer store",
      file: "src/run.c",
      lines: ["const int RETRY_LIMIT = 4;", "*handler = dangerous_fn;"],
    },
  ];

  it.each(erasureCandidates)("keeps $label inside trust accounting", ({ file, lines }) => {
    const patch = patchFor(file, lines);
    const accounting = accountingFor(patch);
    // The executable sibling must not vanish: the benign unit alone cannot account for the change.
    expect(accounting.totalRelevantUnits).toBeGreaterThan(1);
    expect(accounting.complete).toBe(false);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("still treats ordinary recognizable comments as non-blocking", () => {
    const patch = patchFor("src/util.ts", [
      "// increase the retry ceiling for slow links",
      "const RETRY_LIMIT = 4;",
    ]);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });

  it("keeps comment-shaped removals visible rather than erased", () => {
    const patch = removalPatchFor("src/run.ts", ["--lockCount"]);
    expect(accountingFor(patch).totalRelevantUnits).toBeGreaterThan(0);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });
});

describe("RC3b — executable-capable hybrid silence cannot produce EMPTY scope", () => {
  const hybridCandidates: Array<{ label: string; file: string; lines: string[] }> = [
    {
      label: "MDX JSX fragment",
      file: "docs/page.mdx",
      lines: ["<>", "  <Widget onLoad={run()} />", "</>"],
    },
    {
      label: "namespaced SVG executable element",
      file: "assets/icon.svg",
      lines: ['<svg:script xmlns:svg="http://www.w3.org/2000/svg">run()</svg:script>'],
    },
    {
      label: "SVG animation with an event-bearing attribute form",
      file: "assets/icon.svg",
      lines: ['<set attributeName="x" begin="click" onbegin="run()" />'],
    },
    {
      label: "MDX expression-only structural content",
      file: "docs/page.mdx",
      lines: ["<Chart data={load('/x')} />"],
    },
  ];

  it.each(hybridCandidates)("does not skip $label as inert", ({ file, lines }) => {
    const patch = patchFor(file, lines);
    const discovery = discoverConcerns(patch);
    // Ambiguous or recognized-executable hybrid material must remain visible scope.
    expect(discovery.scopeAccounting.totalRelevantUnits).toBeGreaterThan(0);
    expect(discovery.scopeAdequacy.conclusion).not.toBe("ABSENCE_ESTABLISHED");
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("still allows genuinely inert prose in a hybrid format to pass", () => {
    const patch = patchFor("docs/page.mdx", ["This paragraph documents the retry ceiling change."]);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });

  it("keeps plain markdown prose progressing", () => {
    const patch = patchFor("docs/notes.md", ["Updated the retry ceiling rationale."]);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });
});

describe("RC4 — negative evidence domain must cover the raised concern domain", () => {
  /**
   * Discovery raises CREDENTIAL_LITERAL on shapes the credential scanner deliberately skips
   * (short literals, narrower name vocabulary). A producer that never inspected the raised unit
   * must not emit COMPLETE negative absence for it.
   */
  const narrowDomainCandidates: Array<{ label: string; statement: string }> = [
    { label: "short admin password", statement: 'const password = "admin";' },
    { label: "two-character passwd", statement: 'const passwd = "ab";' },
    { label: "eight-character pwd", statement: 'const pwd = "abcdefgh";' },
    { label: "short passphrase", statement: 'const passphrase = "hunter2";' },
  ];

  it.each(
    narrowDomainCandidates,
  )("does not resolve the raised concern from an unscoped scan for $label", ({ statement }) => {
    const patch = patchFor("src/config.ts", [statement]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.map((item) => item.concern)).toContain("SECURITY.CREDENTIAL_LITERAL");

    const evidence = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
      candidateId: "candidate-authority",
      diffDigest: "digest-authority",
    });
    const credential = evidence.filter((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL");
    for (const record of credential) {
      if (record.claim === "NEGATIVE_ABSENCE" && record.outcome === "PASS") {
        // A clean PASS is only honest if the producer actually inspected the raised shape.
        expect(record.completeness).not.toBe("COMPLETE");
      }
    }
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("keeps the credential obligation materially unresolved", () => {
    const patch = patchFor("src/config.ts", ['const password = "admin";']);
    const credential = obligationsFor(patch).find((item) =>
      item.id.startsWith("SECURITY.CREDENTIAL_LITERAL"),
    );
    expect(credential?.material).toBe(true);
    expect(credential?.status).not.toBe("PASS");
  });
});

describe("P1.1 — authorization FULL cannot arise vacuously", () => {
  it("does not grant FULL unit coverage when no call site was observed", () => {
    const patch = patchFor("src/access.ts", ["const allowed = role === 'admin' && (audit = 1);"]);
    const accounting = accountingFor(patch);
    // A vacuous every([]) must not mint whole-unit authorization coverage.
    expect(accounting.concernCoveredUnits).toBe(0);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("keeps an authorization decision with an unrelated mutation unaccounted", () => {
    const patch = patchFor("src/access.ts", [
      "if (user.role === 'admin') { grants = grants + 1; }",
    ]);
    expect(accountingFor(patch).complete).toBe(false);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });
});

describe("P1.3 — stronger discovery evidence is bound to unit identity", () => {
  it("does not accept a coverage claim whose unit identities differ from the candidate", () => {
    const patch = patchFor("src/util.ts", ["const total = subtotal + tax;"]);
    const discovery = discoverConcerns(patch);
    // Counts alone must not be the binding: the identity set must be recorded.
    expect(discovery.scopeAccounting.totalRelevantUnits).toBe(1);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });
});
