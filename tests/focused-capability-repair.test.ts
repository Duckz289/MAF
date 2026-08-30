import { describe, expect, it } from "vitest";
import {
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import { deriveTrustState, type QualityReport } from "../src/domain/quality";
import type { ResiliencePostureResult } from "../src/domain/resilience";

const diff = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

const check = (
  state: QualityReport["Security"]["state"],
  coverage: QualityReport["Security"]["coverage"] = "FULL",
): QualityReport["Security"] => ({
  state,
  evidence: ["broad report projection"],
  provenance: "DETERMINISTIC",
  coverage,
});

const report = (overrides: Partial<QualityReport> = {}): QualityReport => ({
  Correctness: check("PASS"),
  Architecture: check("NOT_REQUIRED"),
  Maintainability: check("PASS"),
  Security: check("PASS"),
  Performance: check("NOT_REQUIRED"),
  Resilience: check("NOT_REQUIRED"),
  TestQuality: check("PASS"),
  DebtDelta: check("PASS"),
  ...overrides,
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

const planRequiring = (required: AssurancePlan["required"]): AssurancePlan => ({
  required,
  notRequired: allChecks.filter((item) => !required.includes(item)),
  reasons: Object.fromEntries(
    allChecks.map((item) => [item, "fixture plan requirement"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: Object.fromEntries(
    required.map((item) => [item, "CANDIDATE_EVIDENCE"]),
  ) as NonNullable<AssurancePlan["requirementOrigin"]>,
});

const flowEvidence = (patch: string) => {
  const discovery = discoverConcerns(patch);
  return deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns }).filter(
    (item) => item.concern === "SECURITY.SENSITIVE_INPUT_FLOW",
  );
};

describe("FS1: sensitive-origin local-use completeness", () => {
  const unknownUses: Array<[string, string[]]> = [
    ["computed key", ["const pw = await getpass('pin');", "cache[pw] = true;"]],
    ["container insertion", ["const pw = await getpass('pin');", "const values = [pw];"]],
    ["property write", ["const pw = await getpass('pin');", "state.pin = pw;"]],
    ["sensitive-object mutation", ["const pw = await getpass('pin');", "pw.value = 'changed';"]],
    [
      "alias that later escapes",
      ["const pw = await getpass('pin');", "const copy = pw;", "ship(copy);"],
    ],
    [
      "interpolation",
      ["const pw = await getpass('pin');", ["const label = `pin=$", "{pw}`;"].join("")],
    ],
    ["return", ["const pw = await getpass('pin');", "return pw;"]],
    [
      "multiline computed key",
      ["const pw = await getpass(", "  'pin',", ");", "cache[", "  pw", "] = true;"],
    ],
    ["dense statement", ["const pw = await getpass('pin'); const box = { value: pw };"]],
  ];

  for (const [label, added] of unknownUses) {
    it(`does not emit clean flow evidence for ${label}`, () => {
      const patch = diff(`src/local/${label.replaceAll(" ", "-")}.ts`, added);
      expect(flowEvidence(patch).some((item) => item.outcome === "PASS")).toBe(false);
      expect(
        deriveTrustState("VERIFIED", report(), planRequiring(["CORRECTNESS"]), undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  const localObservations: Array<[string, string[]]> = [
    ["length inspection", ["const pw = await getpass('pin');", "const present = pw.length > 0;"]],
    ["equality", ["const pw = await getpass('pin');", "const matches = pw === expected;"]],
    ["local condition", ["const pw = await getpass('pin');", "if (pw) {", "}"]],
    [
      "local alias observation",
      [
        "const pw = await getpass('pin');",
        "const localCopy = pw;",
        "const present = localCopy.length > 0;",
      ],
    ],
  ];

  for (const [label, added] of localObservations) {
    it(`retains progressive PASS for ${label}`, () => {
      const patch = diff(`src/local/${label.replaceAll(" ", "-")}.ts`, added);
      expect(flowEvidence(patch).some((item) => item.outcome === "PASS")).toBe(true);
      expect(
        deriveTrustState("VERIFIED", report(), planRequiring(["CORRECTNESS"]), undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("MERGE_ELIGIBLE");
    });
  }
});

describe("FS2: plan Security/Resilience use capability-stamped assurance questions", () => {
  const securityPlan = planRequiring(["CORRECTNESS", "SECURITY"]);

  it("does not let broad Security PASS independently resolve a plan requirement", () => {
    const obligations = deriveAssuranceObligations({
      plan: securityPlan,
      report: report({ Security: check("PASS") }),
    });
    const security = obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION");
    expect(security?.status).toBe("NOT_CHECKED");
    expect(security?.evidence.join(" ")).toMatch(/projection.*not consulted/iu);
    expect(unresolvedObligations(obligations)).toContainEqual(security);
  });

  const authorizationDecisions: Array<[string, string, string[]]> = [
    [
      "role membership",
      "src/billing/filter.ts",
      ["export const ok = (roles: string[]): boolean => roles.includes('admin');"],
    ],
    [
      "ownership comparison",
      "src/files/ownership.ts",
      ["const permitted: boolean = resource.ownerId === actor.id;"],
    ],
    [
      "scope membership in a branch",
      "src/api/scope.ts",
      ["if (requestedScopes.some(matchesGrant)) {"],
    ],
    [
      "permission-set result",
      "src/access/permission.ts",
      ["const granted: boolean = permissionSet.check(requestedAction);"],
    ],
    ["policy-result branch", "src/policy/evaluate.ts", ["if (policyResult.allowed) {"]],
  ];

  for (const [label, file, added] of authorizationDecisions) {
    it(`refines ${label} into an unestablishable typed concern`, () => {
      const patch = diff(file, added);
      expect(discoverConcerns(patch).concerns.map((item) => item.concern)).toContain(
        "SECURITY.AUTHORIZATION_BEHAVIOR",
      );
      expect(
        deriveTrustState("VERIFIED", report({ Security: check("PASS") }), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("keeps a security-pathed constant-only change progressive", () => {
    const patch = diff("src/auth/constants.ts", ["const LOGIN_TIMEOUT_MS = 30_000;"]);
    expect(discoverConcerns(patch).concerns).toEqual([]);
    for (const projection of [check("PASS"), check("NOT_CHECKED"), check("UNKNOWN")]) {
      expect(
        deriveTrustState("VERIFIED", report({ Security: projection }), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("MERGE_ELIGIBLE");
    }
  });

  it("does not let broad Resilience PASS resolve without exact relevance/execution evidence", () => {
    const resiliencePlan = planRequiring(["CORRECTNESS", "RESILIENCE"]);
    const patch = diff("src/network/constants.ts", ["const RETRY_LIMIT = 3;"]);
    expect(
      deriveTrustState(
        "VERIFIED",
        report({ Resilience: check("PASS") }),
        resiliencePlan,
        undefined,
        { diffPatch: patch, qualityPreference: "BALANCED" },
      ),
    ).toBe("CORRECTNESS_VERIFIED");

    const relevanceEmpty: ResiliencePostureResult = {
      state: "PASS",
      evidence: ["bounded code relevance found no material scenario"],
      scenarios: [],
      coverage: "FULL",
    };
    expect(
      deriveTrustState(
        "VERIFIED",
        report({ Resilience: check("NOT_CHECKED") }),
        resiliencePlan,
        undefined,
        {
          diffPatch: patch,
          qualityPreference: "BALANCED",
          resiliencePosture: relevanceEmpty,
        },
      ),
    ).toBe("CORRECTNESS_VERIFIED");
  });

  it("requires measured resilience evidence without erasing independent discovery scope", () => {
    const posture: ResiliencePostureResult = {
      state: "PASS",
      evidence: ["candidate-bound scenario execution passed"],
      scenarios: [{ scenario: "TIMEOUT", outcome: "PASSED", evidence: ["exit 0"] }],
      coverage: "FULL",
    };
    const patch = diff("src/network/client.ts", [
      'return await fetch("https://example.test/health");',
    ]);
    expect(
      deriveTrustState(
        "VERIFIED",
        report({ Resilience: check("PASS") }),
        planRequiring(["CORRECTNESS", "RESILIENCE"]),
        undefined,
        { diffPatch: patch, qualityPreference: "BALANCED", resiliencePosture: posture },
      ),
    ).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("FS3: subprocess concern is an invoked dynamic boundary", () => {
  const dynamicBoundaries: Array<[string, string, string[]]> = [
    ["receiver call", "src/engine/Runner.cs", ["Process.run(userCommand, []);"]],
    [
      "import alias call",
      "src/engine/runner.ts",
      ['import { execSync as launch } from "node:child_process";', "launch(request.command);"],
    ],
    ["builder", "src/engine/runner.rs", ["Command::new(user_command).arg('--safe');"]],
    ["constructor boundary", "src/Jobs/Runner.php", ["new Process([$binary, $argument]);"]],
    ["shell command position", "bin/deploy", ['exec "$USER_COMMAND"']],
  ];

  for (const [label, file, added] of dynamicBoundaries) {
    it(`raises for ${label}`, () => {
      expect(discoverConcerns(diff(file, added)).concerns.map((item) => item.concern)).toContain(
        "SECURITY.SUBPROCESS_EXECUTION",
      );
    });
  }

  const nonBoundaries: Array<[string, string, string[]]> = [
    ["fixed receiver call", "src/engine/Runner.cs", ["Process.run('fixed-command', []);"]],
    [
      "import/reference only",
      "src/engine/runner.ts",
      ['import { execSync as launch } from "node:child_process";', "const selected = launch;"],
    ],
    ["fixed imported call", "src/engine/runner.ts", ["execSync('npm run build');"]],
    ["unrelated receiver", "src/data/processor.ts", ["processor.run(userCommand);"]],
  ];

  for (const [label, file, added] of nonBoundaries) {
    it(`stays quiet for ${label}`, () => {
      expect(
        discoverConcerns(diff(file, added)).concerns.map((item) => item.concern),
      ).not.toContain("SECURITY.SUBPROCESS_EXECUTION");
    });
  }
});
