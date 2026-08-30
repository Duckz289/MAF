import { describe, expect, it } from "vitest";
import {
  type ConcernEvidence,
  deriveAssuranceObligations,
  unresolvedObligations,
} from "../src/domain/assurance-obligation";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import { deriveAssuranceQuestionEvidence } from "../src/domain/assurance-question-evidence";
import type { AssurancePlan } from "../src/domain/assurance";
import type { QualityReport } from "../src/domain/quality";

/**
 * Hardening pass #6 — composition and bypass invariants.
 *
 * Pass #5 made capability adequacy mechanical for TYPED concerns. Adversarial probing of that
 * result found the fix was incomplete in a way no single-file reading would reveal: the typed layer
 * and the older plan-required BUCKET layer coexisted, and the typed layer resolved its concerns by
 * consulting the bucket. Three material false-safe paths followed, all reproduced against the live
 * engine before anything was changed:
 *
 *  - a broad `Security: PASS` (a summary of DIFFERENT questions) discharged a typed concern that a
 *    different capability addresses — finding H1 re-entering through a summary;
 *  - a command/subprocess boundary raised NO concern in ANY language, so `execSync(cfg.cmd)` and
 *    `Runtime.getRuntime().exec(...)` merged with SECURITY NOT_REQUIRED;
 *  - a depth request (CRITICAL) was enforced on typed concerns but not on bucket obligations, so
 *    regex-grade evidence silently satisfied a demand for confidence.
 *
 * These tests assert the INVARIANTS, not the probes. Where practical the shapes differ from the
 * ones that originally failed, because a suite that only replays the reproduction confirms the
 * reproduction rather than the rule.
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

describe("UNIT: a broad dimension state cannot resolve a typed concern", () => {
  it("Security PASS does not discharge a concern no evidence was produced for", () => {
    // The core composition invariant. The Security dimension is a projection of several different
    // questions; letting it settle a typed concern is capability B resolving obligation A with an
    // extra step. Shape is deliberately new: a Swift keychain read reaching an error log.
    const patch = diff("src/onboarding/Enrollment.swift", [
      'let secret = SecureEntry.promptForSecret(label: "device key")',
      'logger.error("enrollment failed for \\(secret)")',
    ]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.length).toBeGreaterThan(0);

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      // No concernEvidence supplied: nothing addressed this concern.
    });
    const flow = obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));
    expect(flow?.status).not.toBe("PASS");
    expect(flow?.evidence.join(" ")).toMatch(/deliberately not read as evidence/u);
    expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
  });

  it("typed evidence from the WRONG capability does not resolve a concern", () => {
    // The credential-literal scanner may be perfectly clean and still says nothing about flow.
    const patch = diff("src/app/login.ts", [
      'const password = await getpass("pw");',
      "console.error(`failed ${password}`);",
    ]);
    const discovery = discoverConcerns(patch);
    const wrongProducer: ConcernEvidence[] = [
      {
        concern: "SECURITY.SENSITIVE_INPUT_FLOW",
        producedBy: "SECURITY.CREDENTIAL_LITERAL_SCAN", // does not establish this concern
        outcome: "PASS",
        claim: "NEGATIVE_ABSENCE",
        completeness: "COMPLETE",
        coverage: "FULL",
        strength: "STRUCTURAL",
        analysisScope: "fixture credential-literal scan",
        evidence: ["credential-literal scan found no literals"],
      },
    ];
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      concernEvidence: wrongProducer,
    });
    const flow = obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));
    expect(flow?.status).not.toBe("PASS");
  });

  it("evidence bound to a DIFFERENT candidate is rejected as stale", () => {
    // Provenance invariant: evidence is about a candidate, not about a repository.
    const patch = diff("src/app/login.ts", [
      'const password = await getpass("pw");',
      "console.error(`failed ${password}`);",
    ]);
    const discovery = discoverConcerns(patch);
    const stale: ConcernEvidence[] = [
      {
        concern: "SECURITY.SENSITIVE_INPUT_FLOW",
        producedBy: "SECURITY.SEMANTIC_FLOW_SCAN",
        outcome: "PASS",
        claim: "NEGATIVE_ABSENCE",
        completeness: "COMPLETE",
        coverage: "FULL",
        strength: "STRUCTURAL",
        analysisScope: "fixture local-use analysis",
        evidence: ["clean scan"],
        candidateId: "OTHER-CANDIDATE",
        diffDigest: "OTHER-DIGEST",
      },
    ];
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      concernEvidence: stale,
      candidateId: "THIS-CANDIDATE",
      diffDigest: "THIS-DIGEST",
    });
    const flow = obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));
    expect(flow?.status).not.toBe("PASS");
    expect(flow?.evidence.join(" ")).toMatch(/rejected as stale/u);
  });

  it("correct, candidate-bound, adequately-covered typed evidence DOES resolve", () => {
    // The progressive half: the mechanism must still be able to say yes, or it is just a blocker.
    const patch = diff("src/app/login.ts", ['const password = await getpass("pw");']);
    const discovery = discoverConcerns(patch);
    const good = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
      candidateId: "C1",
      diffDigest: "D1",
    });
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      concernEvidence: good,
      candidateId: "C1",
      diffDigest: "D1",
    });
    const flow = obligations.find((item) => item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"));
    expect(flow?.status).toBe("PASS");
  });

  it("a producing capability that FLAGGED a signal reports it rather than passing", () => {
    const patch = diff("src/app/login.ts", [
      'const password = await getpass("pw");',
      "console.error(`failed ${password}`);",
    ]);
    const discovery = discoverConcerns(patch);
    const produced = deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns });
    expect(produced.some((item) => item.outcome === "WARN")).toBe(true);
  });
});

describe("UNIT: command/subprocess boundaries raise a concern in any language", () => {
  const boundary: Array<[string, string, string[]]> = [
    ["ts", "src/engine/runner.ts", ["export const run = (c: { cmd: string }) => execSync(c.cmd);"]],
    ["python", "src/engine/runner.py", ["subprocess.run(cmd, shell=True)"]],
    ["go", "cmd/agent/main.go", ['out, _ := exec.Command("sh", "-c", userInput).Output()']],
    ["rust", "src/engine/spawn.rs", ['Command::new("sh").arg("-c").arg(&user_input).spawn()?;']],
    ["php", "app/Jobs/Runner.php", ["shell_exec($request->input('cmd'));"]],
    ["java", "src/engine/Executor.java", ["Runtime.getRuntime().exec(cfg.getCommand());"]],
    ["ruby", "lib/runner.rb", ["system(params[:cmd])"]],
    ["csharp", "src/Jobs/Runner.cs", ['Process.Start("bash", userArgs);']],
  ];

  for (const [language, file, added] of boundary) {
    it(`raises SUBPROCESS_EXECUTION for a dynamic command in ${language}`, () => {
      const discovery = discoverConcerns(diff(file, added));
      expect(discovery.concerns.map((item) => item.concern)).toContain(
        "SECURITY.SUBPROCESS_EXECUTION",
      );
    });
  }

  it("nothing in this build establishes subprocess input provenance, so it stays unresolved", () => {
    const patch = diff("src/engine/Executor.java", [
      "Runtime.getRuntime().exec(cfg.getCommand());",
    ]);
    const discovery = discoverConcerns(patch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
    });
    expect(
      unresolvedObligations(obligations).some((item) =>
        item.id.startsWith("SECURITY.SUBPROCESS_EXECUTION"),
      ),
    ).toBe(true);
  });

  const literal: Array<[string, string, string[]]> = [
    ["ts fixed command", "scripts/build.ts", ['execSync("npm run build");']],
    ["python fixed command", "scripts/build.py", ['subprocess.run("make all", shell=True)']],
  ];

  for (const [label, file, added] of literal) {
    it(`stays quiet for ${label} (no input-provenance question exists)`, () => {
      // Progressive assurance: a build script running a constant is not a security incident.
      const discovery = discoverConcerns(diff(file, added));
      expect(discovery.concerns.map((item) => item.concern)).not.toContain(
        "SECURITY.SUBPROCESS_EXECUTION",
      );
    });
  }

  it("does not fire on identifiers that merely contain boundary vocabulary", () => {
    const discovery = discoverConcerns(
      diff("src/core/plan.ts", [
        "const executionMode = plan.mode;",
        "const systemName = config.name;",
      ]),
    );
    expect(discovery.concerns).toEqual([]);
  });
});

describe("UNIT: plan questions triage families while typed concerns own depth", () => {
  const materialPatch = diff("src/app/login.ts", [
    'const password = await getpass("pw");',
    "console.error(`failed ${password}`);",
  ]);

  it("CRITICAL resolves structural triage but leaves the exact concern unresolved", () => {
    const discovery = discoverConcerns(materialPatch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      assuranceQuestionEvidence: deriveAssuranceQuestionEvidence({ discovery }),
      qualityPreference: "CRITICAL",
    });
    const question = obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION");
    expect(question?.status).toBe("PASS");
    expect(
      unresolvedObligations(obligations).some((item) =>
        item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"),
      ),
    ).toBe(true);
  });

  it("the same plan question resolves under BALANCED without laundering the typed concern", () => {
    const discovery = discoverConcerns(materialPatch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      assuranceQuestionEvidence: deriveAssuranceQuestionEvidence({ discovery }),
      qualityPreference: "BALANCED",
    });
    const question = obligations.find((item) => item.id === "SECURITY.ASSURANCE_QUESTION");
    expect(question?.status).toBe("PASS");
    expect(
      unresolvedObligations(obligations).some((item) =>
        item.id.startsWith("SECURITY.SENSITIVE_INPUT_FLOW"),
      ),
    ).toBe(true);
  });

  it("CRITICAL never withholds CORRECTNESS, where executing the suite IS the strongest evidence", () => {
    // The over-block guard. An earlier version of this fix left CORRECTNESS unresolved under
    // CRITICAL even with a passing trusted command — a demand no candidate could ever satisfy.
    const discovery = discoverConcerns(materialPatch);
    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS"]),
      report: report(),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      assuranceQuestionEvidence: deriveAssuranceQuestionEvidence({ discovery }),
      qualityPreference: "CRITICAL",
    });
    const correctness = obligations.find((item) => item.check === "CORRECTNESS");
    expect(correctness?.status).toBe("PASS");
  });

  it("CRITICAL does not block a security-PATHED candidate whose diff contains no material shape", () => {
    // Path keywords raise the PLAN's requirement; only discovered shapes make depth bite. A
    // constant change under src/auth/ must not be held to a standard nothing can meet.
    const patch = diff("src/auth/constants.ts", ["const LOGIN_TIMEOUT_MS = 30_000;"]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns).toEqual([]);

    const obligations = deriveAssuranceObligations({
      plan: planRequiring(["CORRECTNESS", "SECURITY"]),
      report: report({ Security: check("PASS", "FULL") }),
      concerns: discovery.concerns,
      touchedClasses: discovery.touchedClasses,
      assuranceQuestionEvidence: deriveAssuranceQuestionEvidence({ discovery }),
      qualityPreference: "CRITICAL",
    });
    expect(unresolvedObligations(obligations)).toEqual([]);
  });
});

describe("UNIT: a directory name is not a security boundary (C3 regression)", () => {
  /**
   * Adversarial probing reached MERGE_ELIGIBLE by relocating a real command-execution boundary
   * into `docs/` and `tests/`. The concern-discovery filter excluded those subtrees wholesale, so
   * file naming decided whether behaviour was analysed at all — the very anti-pattern finding C3
   * exists to remove, reintroduced through an exclusion list instead of an inclusion list.
   *
   * The invariant: executable source is read wherever it lives. Only non-executable material
   * (documentation, fixture DATA) and un-authored dependency trees are skipped.
   */
  const relocated: Array<[string, string]> = [
    ["docs subtree", "docs/runtime/exec.ts"],
    ["tests subtree", "tests/helpers/exec.ts"],
    ["examples subtree", "examples/quickstart/run.ts"],
    ["fixtures subtree", "fixtures/scenario/run.ts"],
  ];

  for (const [label, file] of relocated) {
    it(`still raises a subprocess concern for executable source in the ${label}`, () => {
      const discovery = discoverConcerns(
        diff(file, ["export const run = (c: { cmd: string }) => execSync(c.cmd);"]),
      );
      expect(discovery.concerns.map((item) => item.concern)).toContain(
        "SECURITY.SUBPROCESS_EXECUTION",
      );
    });
  }

  it("skips genuinely non-executable material rather than the directory it sits in", () => {
    // Documentation and fixture DATA carry no behaviour; that is a statement about the FILE, not
    // about its folder. A markdown file quoting a command must not raise a concern.
    const docs = discoverConcerns(
      diff("docs/guide.md", ["Run `execSync(userCommand)` to execute the pipeline."]),
    );
    expect(docs.concerns).toEqual([]);
  });

  it("skips dependency trees the candidate does not author", () => {
    const vendored = discoverConcerns(
      diff("node_modules/left-pad/index.js", ["module.exports = (s) => execSync(s);"]),
    );
    expect(vendored.concerns).toEqual([]);
  });

  it("reads an extensionless executable script rather than treating it as unknown data", () => {
    const script = discoverConcerns(
      [
        "diff --git a/bin/deploy b/bin/deploy",
        "--- a/bin/deploy",
        "+++ b/bin/deploy",
        "@@ -0,0 +1,2 @@",
        "+#!/usr/bin/env bash",
        '+eval "$USER_CMD"',
      ].join("\n"),
    );
    expect(script.concerns.map((item) => item.concern)).toContain("SECURITY.SUBPROCESS_EXECUTION");
  });
});

describe("UNIT: a capability may only report clean for what it can actually establish", () => {
  /**
   * Final-round adversarial probing found the narrowest and most dangerous version of finding H1
   * yet: the concern was raised by one detector and cleared by a NARROWER one. The semantic flow
   * scanner only knows the sinks it models, so `sendToAnalytics(password)` produced zero exposure
   * pairs and therefore a clean PASS — resolving a concern about a value that had just been handed
   * to a function the scanner cannot see into.
   *
   * The invariant: a clean result is only legitimate for a fact the capability reads COMPLETELY.
   * "This value is never passed anywhere" is such a fact. "Every callee it reaches is safe" is not.
   */
  const leaks: Array<[string, string, string[]]> = [
    [
      "unmodelled helper",
      "src/app/leak.ts",
      ['const secret = await getpass("pw");', "sendToAnalytics(secret);"],
    ],
    [
      "alias then unmodelled helper",
      "src/app/alias.ts",
      // The sink here (`shipDiagnostics`) is one nothing models, which is exactly the point: the
      // value is credential-named and reaches an output-shaped call, so discovery raises the flow
      // concern, and the flow scanner must not then certify it clean.
      [
        "const api_key = process.env.API_KEY;",
        "logDiagnostics(api_key);",
        "const copy = api_key;",
        "shipDiagnostics(copy);",
      ],
    ],
    [
      "short name bound from a concealed source",
      "src/app/short.ts",
      // The value is sensitive because of where it CAME FROM, not because of its name.
      ['const pw = await getpass("pw");', "console.error(`fail ${pw}`);"],
    ],
    [
      "statement-dense single line",
      "src/app/min.ts",
      ["const p = await getpass('pw'); console.error(p);"],
    ],
  ];

  for (const [label, file, added] of leaks) {
    it(`does not emit a clean PASS when a sensitive value escapes via ${label}`, () => {
      const patch = diff(file, added);
      const discovery = discoverConcerns(patch);
      expect(discovery.concerns.length).toBeGreaterThan(0);
      const produced = deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns });
      expect(produced.some((item) => item.outcome === "PASS")).toBe(false);

      const obligations = deriveAssuranceObligations({
        plan: planRequiring(["CORRECTNESS"]),
        report: report({ Security: check("PASS", "FULL") }),
        concerns: discovery.concerns,
        touchedClasses: discovery.touchedClasses,
        concernEvidence: produced,
      });
      expect(unresolvedObligations(obligations).length).toBeGreaterThan(0);
    });
  }

  it("still emits a clean PASS when the sensitive value genuinely goes nowhere", () => {
    // The progressive half. Without this, the rule above would be a blanket block on every diff
    // that reads a secret at all, which is not assurance — it is refusal.
    const patch = diff("src/app/ok.ts", ['const password = await getpass("pw");']);
    const discovery = discoverConcerns(patch);
    const produced = deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns });
    expect(produced.some((item) => item.outcome === "PASS")).toBe(true);
  });
});
