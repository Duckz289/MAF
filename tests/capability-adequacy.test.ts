import { describe, expect, it } from "vitest";
import { buildAssurancePlan } from "../src/domain/assurance";
import type { AssurancePlan } from "../src/domain/assurance";
import {
  capabilitiesEstablishing,
  capabilityCoverageFor,
  languageClassOf,
  meetsStrength,
} from "../src/domain/capability-adequacy";
import { discoverConcerns } from "../src/domain/concern-discovery";
import {
  type AssuranceQuestionEvidence,
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import { attributeVerificationFailure } from "../src/domain/verification-attribution";
import type { QualityReport } from "../src/domain/quality";
import { type MissionNode, MissionTree, missionHandoffBasis } from "../src/domain/mission-tree";

/**
 * Capability-adequacy hardening (pass #5).
 *
 * These are INVARIANT tests, not reproductions. The three false-safe merge paths an independent
 * re-audit found were all reachable because adequacy was descriptive: coverage was a property of
 * the language, `doesNotEstablish` was prose, and a concern only existed if a path keyword raised
 * one. A test suite that only re-ran the auditor's three examples would confirm those three
 * strings were handled, which is exactly the overfitting the fix is meant to avoid.
 *
 * So every candidate shape below is NEW. The auditor used Ruby `$stdin.gets`, Python
 * `os.environ.get`, and Go `term.ReadPassword`. These use Kotlin, Rust, Elixir, C#, Perl, Swift,
 * PHP and Java, in file paths that mostly do NOT contain a security keyword — because the point is
 * that neither the language nor the path is what raises the concern.
 */

const diff = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

const check = (
  state: QualityReport["Security"]["state"],
  coverage?: QualityReport["Security"]["coverage"],
): QualityReport["Security"] => ({
  state,
  evidence: ["fixture evidence"],
  provenance: "DETERMINISTIC",
  ...(coverage ? { coverage } : {}),
});

const report = (overrides: Partial<QualityReport> = {}): QualityReport => ({
  Correctness: check("PASS"),
  Architecture: check("NOT_REQUIRED"),
  Maintainability: check("PASS"),
  Security: check("NOT_REQUIRED"),
  Performance: check("NOT_REQUIRED"),
  Resilience: check("NOT_REQUIRED"),
  TestQuality: check("PASS"),
  DebtDelta: check("PASS"),
  ...overrides,
});

const securityQuestionEvidence = (
  coverage: "FULL" | "PARTIAL" | "UNSUPPORTED",
): AssuranceQuestionEvidence[] => [
  {
    question: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
    check: "SECURITY",
    producedBy: "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER",
    outcome: "PASS",
    claim: "NEGATIVE_ABSENCE",
    completeness: "COMPLETE",
    coverage,
    strength: "STRUCTURAL",
    languageClasses: ["TS_JS"],
    analysisScope: "fixture fixed-data-only scope",
    evidence: ["bounded structural concern discovery completed"],
  },
];

const planRequiring = (checks: AssurancePlan["required"]): AssurancePlan => ({
  required: checks,
  notRequired: [],
  reasons: Object.fromEntries(
    checks.map((item) => [item, "fixture: required for this test"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: Object.fromEntries(
    checks.map((item) => [item, "CANDIDATE_EVIDENCE"]),
  ) as NonNullable<AssurancePlan["requirementOrigin"]>,
});

const missionNode = (overrides: Partial<MissionNode> & { id: string }): MissionNode => ({
  dependencyIds: [],
  state: "READY",
  executionMode: "GUIDED",
  agent: "fixture",
  model: "fixture",
  budget: 0,
  inputs: [],
  outputs: [],
  verificationState: "VERIFIED",
  ...overrides,
});

describe("UNIT: a capability resolves only what it establishes (finding H1)", () => {
  it("nothing in this build establishes authorization correctness, so no PASS can settle it", () => {
    // The mechanical form of `doesNotEstablish`. This is a claim about the registry itself: if a
    // capability is ever added that genuinely evaluates authorization, this test's premise changes
    // and it should be updated deliberately — which is the point of asserting it.
    expect(capabilitiesEstablishing("SECURITY.AUTHORIZATION_BEHAVIOR")).toEqual([]);
  });

  it("the credential-literal scanner does not establish a sensitive-input flow", () => {
    const verdict = capabilityCoverageFor(
      "SECURITY.CREDENTIAL_LITERAL_SCAN",
      "SECURITY.SENSITIVE_INPUT_FLOW",
      ["PYTHON"],
    );
    expect(verdict.establishes).toBe(false);
    expect(verdict.reason).toMatch(/does not establish/u);
  });

  it("the credential-literal scanner does not establish environment-secret exposure", () => {
    // Invariant 9: a hidden-input/credential-literal scanner PASS cannot resolve an env-secret
    // obligation, because it answers "was a secret WRITTEN here", not "was one LEAKED here".
    const verdict = capabilityCoverageFor(
      "SECURITY.CREDENTIAL_LITERAL_SCAN",
      "SECURITY.ENV_SECRET_EXPOSURE",
      ["TS_JS"],
    );
    expect(verdict.establishes).toBe(false);
  });

  it("an authz concern raises an obligation that stays unresolved even when Security PASSes", () => {
    // NEW shape: Kotlin, in a path with no security keyword whatsoever.
    const patch = diff("src/billing/InvoiceRouter.kt", [
      "fun route(user: User, invoice: Invoice): Response {",
      '    if (user.hasPermission("invoice.read")) {',
      "        return Response.ok(invoice)",
      "    }",
      "    return Response.forbidden()",
      "}",
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.map((item) => item.concern)).toContain(
      "SECURITY.AUTHORIZATION_BEHAVIOR",
    );

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    const authz = obligations.find((item) => item.id.startsWith("SECURITY.AUTHORIZATION_BEHAVIOR"));
    expect(authz).toBeDefined();
    expect(authz?.status).not.toBe("PASS");
    expect(unresolvedObligations(obligations)).toContainEqual(
      expect.objectContaining({ id: authz?.id }),
    );
  });
});

describe("UNIT: PARTIAL coverage does not resolve a material obligation (finding C1)", () => {
  it("a PASS under PARTIAL coverage leaves a material obligation open", () => {
    // Invariant 2. The status becomes UNKNOWN rather than PASS, and the cheap capability's finding
    // is preserved rather than discarded — uncertainty is not converted into safety, and it is
    // also not thrown away.
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "PARTIAL") }),
      assuranceQuestionEvidence: securityQuestionEvidence("PARTIAL"),
    });
    const security = obligations.find((item) => item.check === "SECURITY");
    expect(security?.status).toBe("UNKNOWN");
    expect(security?.coverage).toBe("PARTIAL");
    expect(security?.evidence.join(" ")).toMatch(/PARTIAL coverage/u);
    expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
  });

  it("a PASS under FULL coverage still resolves, so partial-blocking is not blanket-blocking", () => {
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      assuranceQuestionEvidence: securityQuestionEvidence("FULL"),
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });
});

describe("UNIT: coverage is capability-specific, not language-global (finding C2)", () => {
  it("positive detection coverage is not negative-absence coverage", () => {
    const positive = capabilityCoverageFor(
      "SECURITY.CONCERN_DISCOVERY",
      "SECURITY.MATERIAL_CONCERN_DISCOVERY",
      ["TS_JS"],
      "POSITIVE_FINDING",
    );
    const negative = capabilityCoverageFor(
      "SECURITY.CONCERN_DISCOVERY",
      "SECURITY.MATERIAL_CONCERN_DISCOVERY",
      ["TS_JS"],
      "NEGATIVE_ABSENCE",
    );
    expect(positive.coverage).toBe("FULL");
    expect(negative.coverage).not.toBe("FULL");
  });

  it("Python is not uniformly FULL — it depends on which concern is being established", () => {
    // Invariant 3. This is the heart of C2: the analyzer models SOME Python security shapes. It
    // reads concealed-input constructs well; it does not read environment-secret flow through
    // helpers, formatters or dicts, so it must not claim FULL there.
    const inputFlow = capabilityCoverageFor(
      "SECURITY.SEMANTIC_FLOW_SCAN",
      "SECURITY.SENSITIVE_INPUT_FLOW",
      ["PYTHON"],
    );
    const envExposure = capabilityCoverageFor(
      "SECURITY.SEMANTIC_FLOW_SCAN",
      "SECURITY.ENV_SECRET_EXPOSURE",
      ["PYTHON"],
    );
    expect(inputFlow.coverage).toBe("FULL");
    expect(envExposure.coverage).toBe("PARTIAL");
    expect(inputFlow.coverage).not.toBe(envExposure.coverage);
  });

  it("the worst language class in a mixed diff decides coverage, so one file cannot launder another", () => {
    const mixed = capabilityCoverageFor(
      "SECURITY.SEMANTIC_FLOW_SCAN",
      "SECURITY.SENSITIVE_INPUT_FLOW",
      ["TS_JS", "UNMODELLED"],
    );
    expect(mixed.coverage).toBe("UNSUPPORTED");
  });

  it("an unknown extension is classified UNMODELLED rather than assumed readable", () => {
    expect(languageClassOf("src/service/handler.zig")).toBe("UNMODELLED");
    expect(languageClassOf("src/service/handler.ts")).toBe("TS_JS");
  });
});

describe("UNIT: unsupported behavioural code cannot become safety (findings C3/D)", () => {
  it("a concern is raised by code SHAPE even when the path has no security keyword", () => {
    // Invariant 4, with a NEW shape: Rust, at `src/net/listener.rs` — no auth/session/credential
    // anywhere in the path. Under the old design this raised nothing and merged.
    const patch = diff("src/net/listener.rs", [
      'let api_token = std::env::var("SERVICE_API_TOKEN").unwrap();',
      'println!("connecting with {}", api_token);',
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.length).toBeGreaterThan(0);
    expect(discovery.concerns.map((item) => item.concern)).toContain(
      "SECURITY.ENV_SECRET_EXPOSURE",
    );
  });

  it("an unmodelled language yields UNSUPPORTED coverage, so 'found nothing' cannot resolve it", () => {
    const patch = diff("src/net/listener.rs", [
      'let api_token = std::env::var("SERVICE_API_TOKEN").unwrap();',
      'println!("connecting with {}", api_token);',
    ]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      // Security PASSed — and it still must not settle a concern in a language it cannot read.
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    const env = obligations.find((item) => item.id.startsWith("SECURITY.ENV_SECRET_EXPOSURE"));
    expect(env?.status).toBe("UNSUPPORTED");
    expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
  });

  it("concealed input in Swift raises a flow concern with no path keyword and no modelled API", () => {
    // NEW shape again: Swift, and an invented concealment API name. The detector matches the
    // CONCEPT of concealment, so a runtime nobody listed still raises the question.
    const patch = diff("src/onboarding/Enrollment.swift", [
      'let secret = SecureEntry.promptForSecret(label: "device key")',
      'logger.error("enrollment failed for \\(secret)")',
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.map((item) => item.concern)).toContain(
      "SECURITY.SENSITIVE_INPUT_FLOW",
    );
  });

  it("harmless unsupported code raises NO concern, so assurance stays progressive (invariant 5)", () => {
    // The other half of C3, and the one that keeps MAF usable: an unsupported language is not a
    // reason to block. A pure formatting helper in Elixir raises nothing at all.
    const patch = diff("lib/text/formatter.ex", [
      "def titlecase(value) do",
      '  value |> String.split(" ") |> Enum.map(&String.capitalize/1) |> Enum.join(" ")',
      "end",
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns).toEqual([]);

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });

  it("a C# config read with no sensitive name and no sink stays lightweight", () => {
    // Behavioural POSSIBILITY is not a MATERIAL concern. Reading a page size from config is not a
    // secret exposure, and treating it as one is how a security model becomes noise.
    const patch = diff("src/Reporting/PageOptions.cs", [
      'var pageSize = Configuration.GetValue<int>("Reporting:PageSize");',
      "return new PageOptions(pageSize);",
    ]);
    expect(discoverConcerns(patch).concerns).toEqual([]);
  });
});

describe("UNIT: policy depth demands evidence strength, not more cheap checks (finding H2)", () => {
  it("CRITICAL cannot be satisfied by evidence weaker than it asks for (invariant 6)", () => {
    // NEW shape: Perl, and a real concern. Under CRITICAL the structural scanner's evidence is
    // too weak to settle it, and — crucially — MAF says so instead of inventing stronger evidence.
    const patch = diff("bin/sync_accounts.pl", [
      "my $api_key = $ENV{'PARTNER_API_KEY'};",
      'print STDERR "using key $api_key\\n";',
    ]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      qualityPreference: "CRITICAL",
    });
    const env = obligations.find((item) => item.id.startsWith("SECURITY.ENV_SECRET_EXPOSURE"));
    expect(env?.status).not.toBe("PASS");
    expect(env?.evidence.join(" ")).toMatch(/requested assurance depth/u);
    expect(env?.evidence.join(" ")).toMatch(/cannot satisfy it/u);
  });

  it("CRITICAL on a genuinely harmless task forces no expensive verifier (invariant 7)", () => {
    // The counterpart guard. Policy raises the BAR for concerns that exist; it does not conjure
    // concerns. A whitespace-only formatter under CRITICAL stays clean and mergeable.
    const patch = diff("src/format/indent.ts", [
      "export const indent = (text: string, width: number): string =>",
      '  text.split("\\n").map((line) => " ".repeat(width) + line).join("\\n");',
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns).toEqual([]);

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      qualityPreference: "CRITICAL",
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });

  it("the strength ladder is ordered and lexical evidence never satisfies a behavioural demand", () => {
    expect(meetsStrength("LEXICAL", "BEHAVIORAL")).toBe(false);
    expect(meetsStrength("STRUCTURAL", "BEHAVIORAL")).toBe(false);
    expect(meetsStrength("MEASURED", "BEHAVIORAL")).toBe(true);
    expect(meetsStrength("STRUCTURAL", "STRUCTURAL")).toBe(true);
  });
});

describe("UNIT: resilience capability matching (finding/Part H)", () => {
  it("a code-content relevance scan does not establish operational-artefact failure behaviour", () => {
    // Invariant 10: "no fetch() in the source" says nothing about a deploy manifest. The concern
    // and the capability must address the same question.
    expect(capabilitiesEstablishing("RESILIENCE.OPERATIONAL_ARTEFACT")).toEqual([]);
    const verdict = capabilityCoverageFor(
      "RESILIENCE.CODE_RELEVANCE_SCAN",
      "RESILIENCE.OPERATIONAL_ARTEFACT",
      ["CONFIG_WORKFLOW"],
    );
    expect(verdict.establishes).toBe(false);
  });

  it("executed fault scenarios are MEASURED evidence, unlike the relevance scan", () => {
    const scan = capabilityCoverageFor(
      "RESILIENCE.CODE_RELEVANCE_SCAN",
      "RESILIENCE.CODE_FAULT_SCENARIO",
      ["TS_JS"],
    );
    const executed = capabilityCoverageFor(
      "RESILIENCE.FAULT_SCENARIO_EXECUTION",
      "RESILIENCE.CODE_FAULT_SCENARIO",
      ["TS_JS"],
    );
    expect(scan.strength).toBe("STRUCTURAL");
    expect(executed.strength).toBe("MEASURED");
  });
});

describe("SYSTEM_COMPOSITION: mission trust basis must be declared (finding H4)", () => {
  it("a new node without an explicit trust basis fails safe (invariant 11)", () => {
    const node = missionNode({ id: "fresh" });
    expect(missionHandoffBasis(node)).toBe("UNDECLARED");
    const tree = new MissionTree(node);
    expect(() => tree.promote("fresh", "artifact")).toThrow(/legacy trust basis/u);
  });

  it("an explicitly legacy node preserves historical correctness-only semantics (invariant 12)", () => {
    const node = missionNode({ id: "old", legacyTrustBasis: true });
    expect(missionHandoffBasis(node)).toBe("CORRECTNESS_ONLY");
    expect(() => new MissionTree(node).promote("old", "artifact")).not.toThrow();
  });

  it("a quality-blocked candidate cannot ride in on an omitted field", () => {
    const tree = new MissionTree(
      missionNode({ id: "blocked", trustState: "CORRECTNESS_VERIFIED" }),
    );
    expect(() => tree.promote("blocked", "artifact")).toThrow(/not MERGE_ELIGIBLE/u);
  });
});

describe("UNIT: failure attribution precision (finding H3 / Part J)", () => {
  it("'1 failed to start the server' is not a candidate-owned test failure (invariant 14)", () => {
    const attribution = attributeVerificationFailure({
      exitCode: 1,
      output: "1 failed to start the server on port 8080",
    });
    expect(attribution.kind).not.toBe("CANDIDATE_FAILURE");
  });

  it("a real runner summary count is still attributed to the candidate", () => {
    // The narrowing must not cost real detection. Terminal counts are how runners actually print.
    expect(attributeVerificationFailure({ exitCode: 1, output: "2 failed, 8 passed" }).kind).toBe(
      "CANDIDATE_FAILURE",
    );
    expect(
      attributeVerificationFailure({ exitCode: 1, output: "Tests: 3 failed | 7 passed" }).kind,
    ).toBe("CANDIDATE_FAILURE");
    expect(attributeVerificationFailure({ exitCode: 1, output: "5 failed" }).kind).toBe(
      "CANDIDATE_FAILURE",
    );
  });

  it("assertion failures remain candidate-owned (invariant 13 support)", () => {
    expect(
      attributeVerificationFailure({
        exitCode: 1,
        output: "AssertionError: expected 3 to be 4",
      }).kind,
    ).toBe("CANDIDATE_FAILURE");
  });
});

describe("LIVE_ENGINE: adversarial generalization across unfamiliar shapes", () => {
  it("a PHP credential flow in a non-security path raises a concern that partial coverage cannot close", () => {
    // NEW shape: PHP, at `app/Http/Controllers/ReportController.php`. Generic scripting = PARTIAL
    // coverage for input flow, so even a Security PASS leaves this open.
    const patch = diff("app/Http/Controllers/ReportController.php", [
      "$session_key = $request->input('session_key');",
      'error_log("report requested with " . $session_key);',
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.length).toBeGreaterThan(0);

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "PARTIAL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
  });

  it("a Java authorization change in a neutrally named file blocks on the authz gap", () => {
    const patch = diff("src/main/java/com/acme/report/Dispatcher.java", [
      "public boolean canAccess(User user, Report report) {",
      '    return user.hasRole("analyst") || report.isPublic();',
      "}",
    ]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    expect(
      unresolvedObligations(obligations).some((item) =>
        item.id.startsWith("SECURITY.AUTHORIZATION_BEHAVIOR"),
      ),
    ).toBe(true);
  });

  it("a plan built from a real risk vector still merges a harmless change (no blanket blocking)", () => {
    // Guards the whole pass against the failure mode of "make everything unresolved". A plain
    // pure-function change with a real plan and a clean report must still resolve cleanly.
    const patch = diff("src/math/clamp.ts", [
      "export const clamp = (value: number, min: number, max: number): number =>",
      "  Math.min(Math.max(value, min), max);",
    ]);
    const discovery = discoverConcerns(patch);
    const plan = buildAssurancePlan(
      {
        BlastRadius: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        CodeCoupling: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        ArchitectureSensitivity: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        DebtRisk: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        SecuritySensitivity: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        PerformanceSensitivity: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        OperationalSensitivity: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        NetworkBoundaryChanges: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        DataConsistencyRisk: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
        ReasoningDifficulty: { level: "LOW", provenance: "DETERMINISTIC", evidence: [] },
      },
      "BALANCED",
    );
    const obligations = deriveAssuranceObligations({
      plan,
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      qualityPreference: "BALANCED",
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });

  it("candidate id and diff digest stay bound to every obligation (invariant 15)", () => {
    const patch = diff("src/net/listener.rs", [
      'let api_token = std::env::var("SERVICE_API_TOKEN").unwrap();',
      'println!("{}", api_token);',
    ]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      candidateId: "cand-42",
      diffDigest: "sha256:abcdef",
    });
    expect(obligations.length).toBeGreaterThan(0);
    for (const obligation of obligations) {
      expect(obligation.candidateId).toBe("cand-42");
      expect(obligation.diffDigest).toBe("sha256:abcdef");
    }
  });
});
