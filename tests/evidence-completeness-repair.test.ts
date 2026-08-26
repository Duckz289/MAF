import { describe, expect, it } from "vitest";
import {
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import type { AssurancePlan } from "../src/domain/assurance";
import { deriveAssuranceQuestionEvidence } from "../src/domain/assurance-question-evidence";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import {
  assuranceObligationsFor,
  deriveQualityReport,
  deriveTrustState,
  type QualityReport,
} from "../src/domain/quality";
import type { RiskVector } from "../src/domain/risk";

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
  evidence: ["broad projection fixture"],
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

const planRequiring = (required: AssurancePlan["required"]): AssurancePlan => ({
  required,
  notRequired: everyCheck.filter((checkName) => !required.includes(checkName)),
  reasons: Object.fromEntries(
    everyCheck.map((checkName) => [checkName, "fixture requirement"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: Object.fromEntries(
    required.map((checkName) => [checkName, "CANDIDATE_EVIDENCE"]),
  ) as NonNullable<AssurancePlan["requirementOrigin"]>,
});

const correctnessPlan = planRequiring(["CORRECTNESS"]);
const securityPlan = planRequiring(["CORRECTNESS", "SECURITY"]);

const flowEvidence = (patch: string) => {
  const discovery = discoverConcerns(patch);
  return deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns }).filter(
    (item) => item.concern === "SECURITY.SENSITIVE_INPUT_FLOW",
  );
};

describe("sensitive-flow PASS requires an enumerated completeness tuple", () => {
  const incompleteShapes: Array<[string, string, string[]]> = [
    ["inline source", "src/session/inline.ts", ["audit(await getpass('pin'));"]],
    [
      "destructured source",
      "src/session/destructure.ts",
      ["const [p] = [await getpass('pin')];", "cache[p] = true;"],
    ],
    ["exported source", "src/session/export.ts", ["export const p = await getpass('pin');"]],
    ["stored source", "src/session/store.ts", ["state.pin = await getpass('pin');"]],
    [
      "nested source expression",
      "src/session/nested.ts",
      ["const p = normalize(await getpass('pin'));", "const present = p.length > 0;"],
    ],
    [
      "python interpolation",
      "src/session/prompt.py",
      ["p = getpass('pin')", 'print(f"value={p}")'],
    ],
    [
      "alias into nested container",
      "src/session/payload.ts",
      ["const p = await getpass('pin');", "const c = p;", "const payload = { nested: { c } };"],
    ],
    [
      "multiline nested origin",
      "src/session/multiline.ts",
      ["const p = normalize(", "  await getpass('pin'),", ");", "while (p) {", "}"],
    ],
  ];

  for (const [label, file, added] of incompleteShapes) {
    it(`keeps ${label} unresolved instead of treating an untracked use as absence`, () => {
      const patch = diff(file, added);
      const discovery = discoverConcerns(patch);
      expect(discovery.concerns.map((item) => item.concern)).toContain(
        "SECURITY.SENSITIVE_INPUT_FLOW",
      );
      const evidence = flowEvidence(patch);
      expect(evidence.some((item) => item.outcome === "PASS")).toBe(false);
      expect(
        evidence.some(
          (item) => item.completeness === "INCOMPLETE" || item.claim === "POSITIVE_FINDING",
        ),
      ).toBe(true);
      expect(
        deriveTrustState("VERIFIED", report(), correctnessPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  const completeLocalShapes: Array<[string, string[]]> = [
    ["length", ["const p = await getpass('pin');", "const present = p.length > 0;"]],
    ["reverse comparison", ["const p = await getpass('pin');", "const same = expected === p;"]],
    ["local loop condition", ["const p = await getpass('pin');", "while (p) {", "}"]],
    [
      "fully classified alias",
      ["const p = await getpass('pin');", "const c = p;", "const same = c !== previous;"],
    ],
  ];

  for (const [label, added] of completeLocalShapes) {
    it(`retains progressive bounded PASS for ${label}`, () => {
      const patch = diff(`src/session/${label.replaceAll(" ", "-")}.ts`, added);
      const evidence = flowEvidence(patch);
      expect(evidence).toContainEqual(
        expect.objectContaining({
          outcome: "PASS",
          claim: "NEGATIVE_ABSENCE",
          completeness: "COMPLETE",
          coverage: "FULL",
        }),
      );
      expect(
        deriveTrustState("VERIFIED", report(), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("MERGE_ELIGIBLE");
    });
  }

  it("the obligation fold rejects a forged PASS whose completeness is INCOMPLETE", () => {
    const patch = diff("src/session/forged.ts", ["const p = await getpass('pin');"]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: correctnessPlan,
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      concernEvidence: [
        {
          concern: "SECURITY.SENSITIVE_INPUT_FLOW",
          producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
          outcome: "PASS",
          claim: "NEGATIVE_ABSENCE",
          completeness: "INCOMPLETE",
          coverage: "FULL",
          strength: "STRUCTURAL",
          analysisScope: "forged incomplete scope",
          evidence: ["claimed clean without complete use enumeration"],
        },
      ],
    });
    expect(
      obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"))?.status,
    ).not.toBe("PASS");
  });
});

describe("positive discovery authority is separate from negative-absence authority", () => {
  const decisions: Array<[string, string[]]> = [
    ["ownership representation", ["actor.kind === 'staff';", "record.createdBy === actor.id;"]],
    ["group membership", ["return subject.groups.has(team.id);"]],
    ["tenant boundary", ["request.tenantId === resource.partitionId;"]],
    ["ACL decision", ["return acl.evaluate(subject, record);"]],
    ["feature entitlement", ["if (features[account.plan]) {"]],
    ["record-level access", ["document.createdBy === actor.id;"]],
  ];

  for (const [label, added] of decisions) {
    it(`does not convert silent bounded discovery into negative PASS for ${label}`, () => {
      const patch = diff(`src/auth/${label.replaceAll(" ", "-")}.ts`, added);
      const discovery = discoverConcerns(patch);
      const question = deriveAssuranceQuestionEvidence({ discovery })[0];
      if (discovery.concerns.length === 0) {
        expect(discovery.conclusion).toBe("INCOMPLETE");
        expect(discovery.coverage).not.toBe("FULL");
        expect(question).toMatchObject({
          outcome: "NOT_CHECKED",
          claim: "NEGATIVE_ABSENCE",
          completeness: "INCOMPLETE",
        });
      }
      expect(
        deriveTrustState("VERIFIED", report({ Security: check("PASS") }), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("allows positive discovery to refine the plan question without claiming absence", () => {
    const patch = diff("src/auth/known-shape.ts", ["if (tenantPolicy.allowed) {"]);
    const discovery = discoverConcerns(patch);
    const question = deriveAssuranceQuestionEvidence({ discovery })[0];
    expect(discovery.concerns.length).toBeGreaterThan(0);
    expect(question).toMatchObject({
      outcome: "PASS",
      claim: "POSITIVE_FINDING",
      completeness: "NOT_APPLICABLE",
      producedBy: "SECURITY.CONCERN_DISCOVERY",
    });
  });

  it("uses a separate complete fixed-data classifier for an auth-path constant", () => {
    const patch = diff("src/auth/constants.ts", ["const LOGIN_TIMEOUT_MS = 30_000;"]);
    const discovery = discoverConcerns(patch);
    const question = deriveAssuranceQuestionEvidence({ discovery })[0];
    expect(discovery).toMatchObject({
      concerns: [],
      conclusion: "ABSENCE_ESTABLISHED",
      completeness: "COMPLETE",
      coverage: "FULL",
    });
    expect(question).toMatchObject({
      outcome: "PASS",
      claim: "NEGATIVE_ABSENCE",
      completeness: "COMPLETE",
      producedBy: "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER",
    });
    expect(
      deriveTrustState(
        "VERIFIED",
        report({ Security: check("UNKNOWN") }),
        securityPlan,
        undefined,
        {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        },
      ),
    ).toBe("MERGE_ELIGIBLE");
  });

  it("rejects negative PASS from the positive-only concern detector", () => {
    const patch = diff("src/auth/gate.ts", ["actor.kind === 'staff';"]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: securityPlan,
      report: report(),
      assuranceQuestionEvidence: [
        {
          question: "SECURITY.MATERIAL_CONCERN_DISCOVERY",
          check: "SECURITY",
          producedBy: "SECURITY.CONCERN_DISCOVERY",
          outcome: "PASS",
          claim: "NEGATIVE_ABSENCE",
          completeness: "COMPLETE",
          coverage: "FULL",
          strength: "STRUCTURAL",
          languageClasses: discovery.touchedClasses,
          analysisScope: "forged negative discovery claim",
          evidence: ["detector was silent"],
        },
      ],
    });
    expect(obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION")?.status).not.toBe(
      "PASS",
    );
  });

  it("keeps preference-raised Security material when this build has a checker", () => {
    const preferencePlan: AssurancePlan = {
      ...securityPlan,
      requirementOrigin: {
        ...securityPlan.requirementOrigin,
        SECURITY: "QUALITY_PREFERENCE",
      },
    };
    const patch = diff("src/client/network.ts", ["return await fetch(endpoint);"]);
    const obligations = assuranceObligationsFor(report(), preferencePlan, {
      diffPatch: patch,
      qualityPreference: "CRITICAL",
    });
    const security = obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION");
    expect(security).toMatchObject({ status: "NOT_CHECKED", material: true });
    expect(obligations.find((item) => item.id === "DISCOVERY.ADEQUACY")).toMatchObject({
      status: "NOT_CHECKED",
      material: true,
    });
    expect(
      deriveTrustState("VERIFIED", report(), preferencePlan, undefined, {
        diffPatch: patch,
        qualityPreference: "CRITICAL",
      }),
    ).toBe("CORRECTNESS_VERIFIED");
  });
});

describe("incomplete execution-boundary recognition cannot become FULL negative evidence", () => {
  const missedBoundaries: Array<[string, string[]]> = [
    ["imported wrapper", ['import { execa } from "execa";', "execa(request.command);"]],
    ["unchanged provenance", ["launchConfiguredTool(request.command);"]],
    ["dynamic wrapper", ["runThroughAdapter(runtimeSelection, userInput);"]],
  ];

  for (const [label, added] of missedBoundaries) {
    it(`blocks plan Security through incomplete evidence for ${label}`, () => {
      const patch = diff(`src/auth/${label.replaceAll(" ", "-")}.ts`, added);
      const discovery = discoverConcerns(patch);
      expect(discovery.conclusion).toBe("INCOMPLETE");
      expect(discovery.coverage).not.toBe("FULL");
      expect(deriveAssuranceQuestionEvidence({ discovery })[0]?.outcome).toBe("NOT_CHECKED");
      expect(
        deriveTrustState("VERIFIED", report(), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  const incompleteButNotSubprocessCases: Array<[string, string, string[]]> = [
    ["fixed literal command", "scripts/release.ts", ["execa('git status');"]],
    [
      "unused subprocess import",
      "scripts/reference.ts",
      ['import { exec } from "node:child_process";'],
    ],
    ["unrelated run-like method", "src/data/processor.ts", ["processor.run();"]],
  ];

  for (const [label, file, added] of incompleteButNotSubprocessCases) {
    it(`does not manufacture a typed subprocess concern for ${label}, but leaves adequacy unresolved`, () => {
      const patch = diff(file, added);
      expect(discoverConcerns(patch).concerns.map((item) => item.concern)).not.toContain(
        "SECURITY.SUBPROCESS_EXECUTION",
      );
      expect(
        deriveTrustState("VERIFIED", report(), correctnessPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("keeps an exactly classified fixed-data edit in an unmodelled language progressive", () => {
    const patch = diff("src/render/frame.rs", ["const FRAME_LIMIT: usize = 64;"]);
    expect(
      deriveTrustState("VERIFIED", report(), correctnessPlan, undefined, {
        diffPatch: patch,
        qualityPreference: "BALANCED",
      }),
    ).toBe("MERGE_ELIGIBLE");
  });
});

const lowRisk = (): RiskVector => {
  const value = {
    level: "LOW" as const,
    provenance: "DETERMINISTIC" as const,
    evidence: ["fixture"],
  };
  return {
    ReasoningDifficulty: value,
    CodeCoupling: value,
    BlastRadius: value,
    ArchitectureSensitivity: value,
    DebtRisk: value,
    SecuritySensitivity: value,
    PerformanceSensitivity: value,
    OperationalSensitivity: value,
    NetworkBoundaryChanges: value,
    DataConsistencyRisk: value,
  };
};

const liveReport = (file: string, added: string[]): QualityReport =>
  deriveQualityReport({
    verificationState: "VERIFIED",
    verificationCommand: "npm test",
    verificationExitCode: 0,
    assurancePlan: securityPlan,
    preExecutionRisk: lowRisk(),
    diffRisk: lowRisk(),
    changedFiles: [file],
    initialModules: ["src"],
    moduleOwnership: { [file]: "src" },
    diffPatch: diff(file, added),
  });

describe("expansion-capable quoted regions cannot disappear from use enumeration", () => {
  const hiddenUses: Array<[string, string, string[]]> = [
    [
      "percent-mapping interpolation",
      "src/session/percent.py",
      ["pw = getpass('pin')", 'print("%(pw)s" % locals())'],
    ],
    ["ruby interpolation", "src/session/mail.rb", ["pw = getpass('pin')", 'warn("pin=#{pw}")']],
    ["php expansion", "src/session/mail.php", ["$pw = getpass('pin');", 'error_log("x $pw");']],
    [
      "template with nested expression",
      "src/session/label.ts",
      ["const p = await getpass('pin');", "emit(`id:${p.trim()}`);"],
    ],
    [
      "format-string name inside quotes plus value",
      "src/session/fmt.py",
      ["p = getpass('pin')", 'print("{p}".format(**{"p": p}))'],
    ],
    ["shell expansion of a short name", "src/session/echo.sh", ["p=$(getpass pin)", "echo $p"]],
  ];

  for (const [label, file, added] of hiddenUses) {
    it(`does not emit clean flow PASS when ${label} could hide a use`, () => {
      const patch = diff(file, added);
      expect(flowEvidence(patch).some((item) => item.outcome === "PASS")).toBe(false);
      expect(
        deriveTrustState("VERIFIED", report(), securityPlan, undefined, {
          diffPatch: patch,
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  it("still treats proven-plain quoted text that merely mentions the name as a non-use", () => {
    const patch = diff("src/session/comment.ts", [
      "const p = await getpass('pin');",
      'const note = "p is local";',
      "const present = p.length > 0;",
    ]);
    expect(flowEvidence(patch)).toContainEqual(
      expect.objectContaining({
        outcome: "PASS",
        completeness: "COMPLETE",
        coverage: "FULL",
      }),
    );
  });
});

describe("claim-relative coverage does not report FULL for incomplete negative search", () => {
  it("caps the Security projection below FULL when discovery did not establish absence", () => {
    const quality = liveReport("src/auth/gate.ts", [
      "actor.kind === 'staff'",
      "record.createdBy === actor.id",
    ]);
    expect(quality.Security.coverage).not.toBe("FULL");
    expect(quality.Security.state).toBe("NOT_CHECKED");
  });

  it("caps the Security projection below FULL for an unclassified dynamic command call", () => {
    const quality = liveReport("src/auth/runner.ts", [
      'import { execa } from "execa";',
      "execa(request.command);",
    ]);
    expect(quality.Security.coverage).not.toBe("FULL");
    expect(quality.Security.state).toBe("NOT_CHECKED");
    expect(
      discoverConcerns(diff("src/auth/runner.ts", ["execa(request.command);"])).coverage,
    ).not.toBe("FULL");
  });

  it("keeps FULL only for a completely classified fixed-data scope", () => {
    const quality = liveReport("src/auth/constants.ts", ["const LOGIN_TIMEOUT_MS = 30_000;"]);
    expect(quality.Security.coverage).toBe("FULL");
  });
});

describe("adversarial generalization of the completeness contract", () => {
  const securityBlocks: Array<[string, string, string[]]> = [
    ["inline source with no identifier", "src/session/inline.ts", ["audit(await getpass('pin'));"]],
    [
      "destructured store",
      "src/session/pair.ts",
      ["const { pin: p } = { pin: await getpass('pin') };", "remember(p);"],
    ],
    ["exported origin", "src/session/exp.ts", ["export const p = await getpass('pin');"]],
    [
      "aliased escape",
      "src/session/alias.ts",
      ["const p = await getpass('pin');", "const q = p;", "ship(q);"],
    ],
    [
      "nested expression origin",
      "src/session/nest.ts",
      ["const p = wrap(await getpass('pin'));", "const ok = p.length > 0;"],
    ],
    [
      "dense one-line store",
      "src/session/dense.ts",
      ["const p = await getpass('pin'); cache[p] = true;"],
    ],
    [
      "ownership comparison outside vocabulary",
      "src/auth/owner.ts",
      ["return record.createdBy === actor.id;"],
    ],
    [
      "tenant partition check",
      "src/auth/tenant.ts",
      ["if (request.tenantId !== resource.partitionId) {", "  deny();", "}"],
    ],
    ["ACL evaluator", "src/auth/acl.ts", ["return acl.evaluate(subject, record);"]],
    [
      "feature entitlement table",
      "src/billing/entitlements.ts",
      ["return features[account.plan] === true;"],
    ],
    [
      "imported wrapper subprocess",
      "src/auth/tools.ts",
      ['import { execa } from "execa";', "execa(request.command);"],
    ],
    [
      "unchanged provenance wrapper",
      "src/auth/launch.ts",
      ["launchConfiguredTool(request.command);"],
    ],
    ["dynamic adapter", "src/auth/adapter.ts", ["runThroughAdapter(runtimeSelection, userInput);"]],
  ];

  for (const [label, file, added] of securityBlocks) {
    it(`does not MERGE ${label}`, () => {
      expect(
        deriveTrustState("VERIFIED", report(), securityPlan, undefined, {
          diffPatch: diff(file, added),
          qualityPreference: "BALANCED",
        }),
      ).toBe("CORRECTNESS_VERIFIED");
    });
  }

  const progressive: Array<[string, string, string[], ReturnType<typeof planRequiring>]> = [
    [
      "length observation",
      "src/session/len.ts",
      ["const p = await getpass('pin');", "const present = p.length > 0;"],
      securityPlan,
    ],
    [
      "local comparison",
      "src/session/eq.ts",
      ["const p = await getpass('pin');", "const same = expected === p;"],
      securityPlan,
    ],
    [
      "local boolean condition",
      "src/session/cond.ts",
      ["const p = await getpass('pin');", "if (p) {", "}"],
      securityPlan,
    ],
    [
      "classified alias",
      "src/session/alias-ok.ts",
      ["const p = await getpass('pin');", "const q = p;", "const same = q !== previous;"],
      securityPlan,
    ],
    [
      "harmless unmodelled edit",
      "src/render/frame.rs",
      ["const FRAME_LIMIT: usize = 64;"],
      correctnessPlan,
    ],
    [
      "auth-path constant",
      "src/auth/constants.ts",
      ["const LOGIN_TIMEOUT_MS = 30_000;"],
      securityPlan,
    ],
  ];

  for (const [label, file, added, plan] of progressive) {
    it(`keeps ${label} progressive`, () => {
      expect(
        discoverConcerns(diff(file, added)).concerns.map((item) => item.concern),
      ).not.toContain("SECURITY.SUBPROCESS_EXECUTION");
      expect(
        deriveTrustState("VERIFIED", report(), plan, undefined, {
          diffPatch: diff(file, added),
          qualityPreference: "BALANCED",
        }),
      ).toBe("MERGE_ELIGIBLE");
    });
  }
});

describe("candidate-bound decision and emitted ledger use identical evidence semantics", () => {
  it("binds both derivations to the same candidate and digest", () => {
    const patch = diff("src/auth/constants.ts", ["const LOGIN_TIMEOUT_MS = 30_000;"]);
    const binding = {
      candidateId: "candidate-completeness",
      diffDigest: "digest-completeness",
      diffPatch: patch,
      qualityPreference: "BALANCED" as const,
    };
    const obligations = assuranceObligationsFor(report(), securityPlan, binding);
    expect(unresolvedObligations(obligations)).toEqual([]);
    expect(
      obligations.every(
        (item) =>
          item.candidateId === binding.candidateId && item.diffDigest === binding.diffDigest,
      ),
    ).toBe(true);
    expect(deriveTrustState("VERIFIED", report(), securityPlan, undefined, binding)).toBe(
      "MERGE_ELIGIBLE",
    );
  });

  it("the trust decision is a fold over the same obligation set the ledger emits", () => {
    const patch = diff("src/auth/gate.ts", ["actor.kind === 'staff';"]);
    const binding = {
      candidateId: "candidate-shared",
      diffDigest: "digest-shared",
      diffPatch: patch,
      qualityPreference: "BALANCED" as const,
    };
    const obligations = assuranceObligationsFor(report(), securityPlan, binding);
    expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
    expect(deriveTrustState("VERIFIED", report(), securityPlan, undefined, binding)).toBe(
      "CORRECTNESS_VERIFIED",
    );
  });
});
