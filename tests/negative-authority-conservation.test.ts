import { describe, expect, it } from "vitest";
import { capabilityCoverageFor, languageClassOf } from "../src/domain/capability-adequacy";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import { deriveSecurityPosture } from "../src/domain/security";

const patchFor = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("language-bound negative authority", () => {
  it("keeps the intended TS bitwise scalar proof", () => {
    expect(
      discoverConcerns(patchFor("src/a.ts", ["const n = a | b;"])).scopeAccounting.complete,
    ).toBe(true);
  });

  it.each([
    ["PowerShell", "src/a.ps1", "let n = a | Get-Process"],
    ["fish", "src/a.fish", "let n = a | wc"],
    ["Ruby", "src/a.rb", "def n = a | system"],
    ["Elixir", "src/a.ex", "def n = a | system"],
  ])("does not apply JS scalar semantics to %s", (_label, file, statement) => {
    const accounting = discoverConcerns(patchFor(file, [statement])).scopeAccounting;
    expect(accounting.promotionAbsenceEstablishedUnits).toBe(0);
    expect(accounting.complete).toBe(false);
  });

  it("does not advertise FULL promotion-negative coverage for generic or unmodelled syntax", () => {
    for (const languageClass of ["GENERIC_SCRIPTING", "UNMODELLED"] as const) {
      expect(
        capabilityCoverageFor(
          "DISCOVERY.BOUNDED_CHANGE_CLASSIFIER",
          "DISCOVERY.MATERIAL_CONCERN_SCOPE_ADEQUACY",
          [languageClass],
          "NEGATIVE_ABSENCE",
        ).coverage,
      ).not.toBe("FULL");
      expect(
        capabilityCoverageFor(
          "SECURITY.NON_BEHAVIORAL_CHANGE_CLASSIFIER",
          "SECURITY.MATERIAL_CONCERN_DISCOVERY",
          [languageClass],
          "NEGATIVE_ABSENCE",
        ).coverage,
      ).not.toBe("FULL");
    }
    expect(languageClassOf("src/a.zig")).toBe("UNMODELLED");
  });

  it.each([
    ["src/a.py", "LIMIT = 4"],
    ["src/a.go", "const LIMIT = 4"],
    ["src/a.rs", "const LIMIT: usize = 4"],
    ["src/a.kt", "const val LIMIT = 4"],
    ["src/a.swift", "let LIMIT = 4"],
    ["src/a.rs", "use std::collections::HashMap"],
    ["src/a.ts", 'import type { Shape } from "./shape";'],
  ])("preserves the supported bounded progression for %s", (file, statement) => {
    expect(discoverConcerns(patchFor(file, [statement])).scopeAccounting.complete).toBe(true);
  });
});

describe("credential producer-owned analysis domain", () => {
  const cases: Array<[string, string, string]> = [
    ["long standard literal", "src/a.ts", 'const password = "correct-horse-battery";'],
    ["short literal", "src/a.ts", 'const password = "abc";'],
    ["pwd vocabulary", "src/a.ts", 'const pwd = "abc";'],
    ["passphrase vocabulary", "src/a.ts", 'const passphrase = "hunter2";'],
    ["Python plain", "src/a.py", 'password = "abcdefgh"'],
    ["Python raw", "src/a.py", 'password = r"abcdefgh"'],
    ["Python bytes", "src/a.py", 'password = b"abcdefgh"'],
    ["Python unicode", "src/a.py", 'password = u"abcdefgh"'],
    ["Python f-string", "src/a.py", 'password = f"{prefix}-secret"'],
    ["placeholder changeme", "src/a.ts", 'const password = "changeme";'],
    ["placeholder x", "src/a.ts", 'const password = "xxxxxxxx";'],
  ];

  it.each(cases)("returns structured producer scope for %s", (_label, file, statement) => {
    const patch = patchFor(file, [statement]);
    const discovery = discoverConcerns(patch);
    expect(discovery.concerns.some((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL")).toBe(
      true,
    );
    const posture = deriveSecurityPosture(patch) as ReturnType<typeof deriveSecurityPosture> & {
      credentialLiteralAnalysis?: {
        predicateId: string;
        analyzedAtoms: Array<{ atomIdentity: string; decision: string }>;
        undecidedAtoms: Array<{ atomIdentity: string; reason: string }>;
      };
    };
    expect(posture.credentialLiteralAnalysis).toBeDefined();

    const evidence = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
      candidateId: "credential-candidate",
      diffDigest: "credential-digest",
    }).filter((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL");
    expect(evidence).toHaveLength(1);
    for (const record of evidence) {
      if (record.claim === "NEGATIVE_ABSENCE" && record.outcome === "PASS") {
        expect(record.completeness).toBe("COMPLETE");
        expect(posture.credentialLiteralAnalysis?.analyzedAtoms.length).toBeGreaterThan(0);
        expect(posture.credentialLiteralAnalysis?.undecidedAtoms).toHaveLength(0);
        expect(record.analysisScope).toContain(posture.credentialLiteralAnalysis?.predicateId);
      }
    }
  });

  it("does not mint COMPLETE absence for interpolation-capable Python f-strings", () => {
    const patch = patchFor("src/a.py", ['password = f"{prefix}-secret"']);
    const discovery = discoverConcerns(patch);
    const evidence = deriveConcernEvidence({ diffPatch: patch, concerns: discovery.concerns });
    const credential = evidence.find((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL");
    expect(credential?.outcome).toBe("NOT_CHECKED");
    expect(credential?.completeness).toBe("INCOMPLETE");
  });

  it.each([
    ["short password", 'const password = "abc";'],
    ["pwd vocabulary", 'const pwd = "abc";'],
    ["passphrase vocabulary", 'const passphrase = "hunter2";'],
    ["Python raw string", 'password = r"abcdefgh"'],
    ["Python bytes string", 'password = b"abcdefgh"'],
    ["Python unicode string", 'password = u"abcdefgh"'],
  ])("emits a producer-owned positive finding for %s", (_label, statement) => {
    const file = statement.startsWith("password =") ? "src/a.py" : "src/a.ts";
    const patch = patchFor(file, [statement]);
    const discovery = discoverConcerns(patch);
    const credential = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
    }).find((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL");
    expect(credential).toMatchObject({
      outcome: "WARN",
      claim: "POSITIVE_FINDING",
      completeness: "NOT_APPLICABLE",
      coverage: "FULL",
    });
  });

  it.each([
    'const password = "changeme";',
    'const password = "xxxxxxxx";',
  ])("issues COMPLETE absence only after explicitly deciding placeholder %s", (statement) => {
    const patch = patchFor("src/a.ts", [statement]);
    const discovery = discoverConcerns(patch);
    const credential = deriveConcernEvidence({
      diffPatch: patch,
      concerns: discovery.concerns,
    }).find((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL");
    expect(credential).toMatchObject({
      outcome: "PASS",
      claim: "NEGATIVE_ABSENCE",
      completeness: "COMPLETE",
      coverage: "FULL",
    });
    expect(credential?.analysisScope).toContain("SECURITY.CREDENTIAL_LITERAL_ASSIGNMENT.V1");
  });

  it("does not create a credential obligation from vocabulary appearing only in a value", () => {
    const patch = patchFor("src/a.ts", ['const label = "password";']);
    expect(
      discoverConcerns(patch).concerns.some(
        (item) => item.concern === "SECURITY.CREDENTIAL_LITERAL",
      ),
    ).toBe(false);
  });

  it("keeps references and expressions outside the literal obligation domain", () => {
    for (const statement of [
      "const password = process.env.PASSWORD;",
      "const pwd = readSecret();",
      "password = config.reference",
    ]) {
      const discovery = discoverConcerns(patchFor("src/a.ts", [statement]));
      expect(
        discovery.concerns.some((item) => item.concern === "SECURITY.CREDENTIAL_LITERAL"),
      ).toBe(false);
    }
  });
});
