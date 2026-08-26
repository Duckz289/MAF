import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { parseFilePatches } from "../src/domain/diff-parse";
import { deriveTrustState, type QualityReport } from "../src/domain/quality";

const patchFor = (file: string, added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join("\n");

const check = (state: QualityReport["Security"]["state"]): QualityReport["Security"] => ({
  state,
  evidence: ["scope-conservation fixture"],
  provenance: "DETERMINISTIC",
  coverage: "FULL",
});

const report = (security: QualityReport["Security"]["state"] = "PASS"): QualityReport => ({
  Correctness: check("PASS"),
  Architecture: check("NOT_REQUIRED"),
  Maintainability: check("PASS"),
  Security: check(security),
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
const plan: AssurancePlan = {
  required: ["CORRECTNESS"],
  notRequired: allChecks.filter((item) => item !== "CORRECTNESS"),
  reasons: Object.fromEntries(
    allChecks.map((item) => [item, "fixture"]),
  ) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};
const trustFor = (patch: string, security: QualityReport["Security"]["state"] = "PASS") =>
  deriveTrustState("VERIFIED", report(security), plan, true, {
    candidateId: "scope-candidate",
    diffDigest: "scope-digest",
    diffPatch: patch,
    qualityPreference: "BALANCED",
  });

interface RawAccounting {
  rawChangedAtoms: number;
  analyzedRawAtoms: number;
  unsupportedRawAtoms: number;
  unclassifiedRawAtoms: number;
  provenIrrelevantRawAtoms: number;
  emptyScopeProven: boolean;
  rawAtomDispositions: Array<{ atomIdentity: string; disposition: string }>;
}

const rawAccounting = (patch: string): RawAccounting =>
  discoverConcerns(patch).scopeAccounting as unknown as RawAccounting;

describe("raw candidate scope conservation", () => {
  it("represents executable mode metadata and refuses zero-scope absence", () => {
    const patch = [
      "diff --git a/scripts/deploy.sh b/scripts/deploy.sh",
      "old mode 100644",
      "new mode 100755",
    ].join("\n");
    const parsed = parseFilePatches(patch);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.uninspectableReasons).toContain("MODE_CHANGE");
    expect(rawAccounting(patch).rawChangedAtoms).toBeGreaterThan(0);
    expect(discoverConcerns(patch).scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it.each([
    ["requirements.txt", ["requests==9.9.9"]],
    ["Cargo.lock", ["[[package]]", 'name = "runtime-loader"']],
    ["src/auth/notes.txt", ['password = "correct-horse-battery"']],
    ["scripts/payload.txt", ["#!/usr/bin/env bash", "exec $COMMAND"]],
    ["fixtures/runtime.snap", ["exports[`runtime`] = `exec(command)`;"]],
  ])("does not treat the %s extension as proof that all bytes are irrelevant", (file, lines) => {
    const patch = patchFor(file as string, lines as string[]);
    const accounting = rawAccounting(patch);
    expect(accounting.rawChangedAtoms).toBeGreaterThan(0);
    expect(accounting.emptyScopeProven).toBe(false);
    expect(discoverConcerns(patch).scopeAdequacy.conclusion).toBe("INCOMPLETE");
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("positively accounts ordinary markdown prose as inert", () => {
    const patch = patchFor("docs/notes.md", ["Updated the retry ceiling rationale."]);
    const accounting = rawAccounting(patch);
    expect(accounting.rawChangedAtoms).toBe(1);
    expect(accounting.provenIrrelevantRawAtoms).toBe(1);
    expect(accounting.emptyScopeProven).toBe(true);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });

  it.each([
    ["MDX runtime-capable link", "docs/page.mdx", ["[run](javascript:launch())"]],
    ["MDX frontmatter-like material", "docs/page.mdx", ["---", "loader: run", "---"]],
    ["markdown runtime-capable link", "docs/page.md", ["[run](javascript:launch())"]],
  ])("keeps %s ambiguous instead of inferring inertness from regex silence", (_label, file, lines) => {
    const patch = patchFor(file, lines);
    expect(rawAccounting(patch).emptyScopeProven).toBe(false);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it("assigns every raw atom exactly one terminal disposition", () => {
    const patches = [
      patchFor("src/a.ts", ["// ordinary comment", "const LIMIT = 4;"]),
      patchFor("docs/a.md", ["Ordinary prose."]),
      patchFor("src/a.ts", ["exec(command);"]),
      patchFor("Cargo.lock", ['name = "opaque"']),
    ];
    for (const patch of patches) {
      const accounting = rawAccounting(patch);
      expect(accounting.rawAtomDispositions).toHaveLength(accounting.rawChangedAtoms);
      expect(new Set(accounting.rawAtomDispositions.map((item) => item.atomIdentity)).size).toBe(
        accounting.rawChangedAtoms,
      );
      expect(
        accounting.analyzedRawAtoms +
          accounting.unsupportedRawAtoms +
          accounting.unclassifiedRawAtoms +
          accounting.provenIrrelevantRawAtoms,
      ).toBe(accounting.rawChangedAtoms);
    }
  });

  it("never converts less analyzable non-empty material into COMPLETE absence", () => {
    for (const patch of [
      patchFor("src/a.ts", ["exec(command);"]),
      patchFor("src/a.unknown", ["opaque behavior"]),
      "malformed but non-empty candidate patch",
    ]) {
      const discovery = discoverConcerns(patch);
      expect(rawAccounting(patch).emptyScopeProven).toBe(false);
      expect(discovery.scopeAdequacy.conclusion).toBe("INCOMPLETE");
    }
  });

  it("does not launder a security WARN through extension-based empty discovery", () => {
    const patch = patchFor("src/auth/notes.txt", ['password = "correct-horse-battery"']);
    expect(trustFor(patch, "WARN")).not.toBe("MERGE_ELIGIBLE");
  });
});

describe("comment, directive, and lexical-context conservation", () => {
  it.each([
    ["JS triple-slash", "src/a.ts", ['/// <reference path="./runtime.ts" />', "const LIMIT = 4;"]],
    ["Go generate", "src/a.go", ["//go:generate sh -c run", "const LIMIT = 4"]],
    ["shebang", "scripts/run.sh", ["#!/usr/bin/env bash"]],
  ])("does not erase the %s directive", (_label, file, lines) => {
    const patch = patchFor(file, lines);
    expect(rawAccounting(patch).provenIrrelevantRawAtoms).toBeLessThan(lines.length);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it.each([
    [
      "JS template",
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@",
        " const template = `",
        "-old",
        "+// exec(command)",
        " `;",
      ].join("\n"),
    ],
    [
      "Python multiline string",
      [
        "diff --git a/src/a.py b/src/a.py",
        "--- a/src/a.py",
        "+++ b/src/a.py",
        "@@ -1,3 +1,3 @@",
        " value = '''",
        "-old",
        "+# exec(command)",
        " '''",
      ].join("\n"),
    ],
    [
      "shell heredoc",
      [
        "diff --git a/scripts/a.sh b/scripts/a.sh",
        "--- a/scripts/a.sh",
        "+++ b/scripts/a.sh",
        "@@ -1,3 +1,3 @@",
        " cat <<EOF",
        "-old",
        "+# exec $COMMAND",
        " EOF",
      ].join("\n"),
    ],
    [
      "YAML block scalar",
      [
        "diff --git a/workflow.yml b/workflow.yml",
        "--- a/workflow.yml",
        "+++ b/workflow.yml",
        "@@ -1,2 +1,2 @@",
        " script: |",
        "-  old",
        "+  # exec $COMMAND",
      ].join("\n"),
    ],
  ])("does not strip comment-shaped text inside a %s", (_label, patch) => {
    expect(rawAccounting(patch).provenIrrelevantRawAtoms).toBe(0);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it.each([
    "--[[ note ]] os.execute(cmd)",
    "--[=[ note ]=] os.execute(cmd)",
  ])("keeps Lua same-line long-comment reentry: %s", (line) => {
    const patch = patchFor("src/a.lua", [line]);
    expect(rawAccounting(patch).provenIrrelevantRawAtoms).toBe(0);
    expect(trustFor(patch)).not.toBe("MERGE_ELIGIBLE");
  });

  it.each([
    ["src/a.ts", "// ordinary comment"],
    ["src/a.py", "# ordinary comment"],
    ["src/a.lua", "-- ordinary comment"],
  ])("keeps a positive inert path for genuine comments in %s", (file, line) => {
    const patch = patchFor(file, [line]);
    expect(rawAccounting(patch).provenIrrelevantRawAtoms).toBe(1);
    expect(trustFor(patch)).toBe("MERGE_ELIGIBLE");
  });
});
