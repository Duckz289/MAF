import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveTrustState, type QualityReport } from "../src/domain/quality";

/** Self-adversarial probe: novel structures against the repaired root contracts. */

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
  evidence: ["probe"],
  provenance: "DETERMINISTIC",
  coverage: "FULL",
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

const plan: AssurancePlan = {
  required: ["CORRECTNESS"],
  notRequired: allChecks.filter((item) => item !== "CORRECTNESS"),
  reasons: Object.fromEntries(allChecks.map((i) => [i, "probe"])) as AssurancePlan["reasons"],
  requirementOrigin: { CORRECTNESS: "CANDIDATE_EVIDENCE" },
};

const trustFor = (diffPatch: string) =>
  deriveTrustState("VERIFIED", report(), plan, true, {
    candidateId: "c",
    diffDigest: "d",
    diffPatch,
    qualityPreference: "BALANCED" as const,
  });

/** Every entry MUST NOT reach MERGE_ELIGIBLE. Reported as a table so all leaks surface at once. */
const attacks: Array<[string, string, string[]]> = [
  // Family A — purity boundaries, novel forms
  ["arrow function body", "src/a.ts", ["const f = x => run(x);"]],
  ["arrow with effect", "src/a.ts", ["const n = (() => { count += 1; return 1; })();"]],
  ["tagged template", "src/a.ts", ["const n = sql`DROP ${table}`;"]],
  ["optional chaining call", "src/a.ts", ["const n = obj?.run?.();"]],
  ["optional chain property", "src/a.ts", ["const n = obj?.value;"]],
  ["spread in array", "src/a.ts", ["const n = [...items];"]],
  ["object literal", "src/a.ts", ["const n = { a: run() };"]],
  ["index access", "src/a.ts", ["const n = items[compute()];"]],
  ["comma in parens", "src/a.ts", ["const n = (a, b);"]],
  ["new expression", "src/a.ts", ["const n = new Thing();"]],
  ["void operator", "src/a.ts", ["const n = void run();"]],
  ["in operator", "src/a.ts", ["const n = key in target;"]],
  ["instanceof", "src/a.ts", ["const n = value instanceof Thing;"]],
  ["assignment in nested ternary", "src/a.ts", ["const n = a ? b ? (c = 1) : 2 : 3;"]],
  ["double negation of assignment", "src/a.ts", ["const n = !!(x = 1);"]],
  ["unary minus on call", "src/a.ts", ["const n = -run();"]],
  ["bitwise with assignment", "src/a.ts", ["const n = mask & (flag = 2);"]],
  ["nested parens hiding assignment", "src/a.ts", ["const n = (((x = 1)));"]],
  ["template literal", "src/a.ts", ["const n = `a${run()}b`;"]],
  ["regex after paren", "src/a.ts", ["const n = (1) / /x/;"]],
  ["regex in operand position", "src/a.ts", ["const n = /x/ + 1;"]],
  ["regex after operator", "src/a.ts", ["const n = a + /x/.source;"]],
  ["getter property read", "src/a.ts", ["const n = config.dangerous;"]],
  ["method call length-like", "src/a.ts", ["const n = value.length();"]],
  ["chained length on call", "src/a.ts", ["const n = get().length;"]],
  ["python walrus", "src/a.py", ["total = (count := 1)"]],
  ["python lambda", "src/a.py", ["f = lambda x: run(x)"]],
  ["rust macro", "src/a.rs", ['let n = println!("{}", secret);']],
  ["go channel receive", "src/a.go", ["n := <-ch"]],
  ["kotlin elvis call", "src/a.kt", ["val n = value ?: compute()"]],
  ["swift force unwrap call", "src/a.swift", ["let n = value!.run()"]],

  // Family H — cross-language comment/segmentation leakage
  ["python hash is comment but JS is not", "src/a.ts", ["#!/usr/bin/env node", "exec(cmd)"]],
  ["sql double dash in ts", "src/a.ts", ["--counter;"]],
  ["lua comment in js file", "src/a.ts", ["--[[ note ]] exec(cmd)"]],
  ["star line in ts is not comment body", "src/a.ts", ["*ptr = dangerous;"]],
  ["semicolon prefix in ts", "src/a.ts", [";exec(cmd)"]],
  ["hash in python is a real comment plus code after", "src/a.py", ["# note", "exec(cmd)"]],
  ["block comment closed then code", "src/a.ts", ["/* x */ exec(cmd)"]],
  ["nested block close then code", "src/a.ts", ["/* a */ /* b */ exec(cmd)"]],
  ["jsx-ish comment brace", "src/a.tsx", ["{/* note */} exec(cmd)"]],

  // Family E — pre-accounting erasure
  ["continuation joins comment to code", "src/a.ts", ["const x = 1 +", "// note", "run();"]],
  ["blank-looking whitespace with code", "src/a.ts", ["   \t exec(cmd)"]],

  // Family F — empty / NOT_APPLICABLE
  [
    "svg with unknown executable element",
    "a/i.svg",
    ['<custom:run xmlns:custom="x">go</custom:run>'],
  ],
  ["mdx with only an expression", "d/p.mdx", ["{run()}"]],
  ["svg style with expression", "a/i.svg", ["<style>@import url(x);</style>"]],
];

describe("self-adversarial probe: no attack may reach MERGE_ELIGIBLE", () => {
  it("reports every candidate that promoted", () => {
    const promoted: string[] = [];
    for (const [label, file, lines] of attacks) {
      const patch = patchFor(file, lines);
      if (trustFor(patch) === "MERGE_ELIGIBLE") {
        const d = discoverConcerns(patch);
        promoted.push(
          `${label} [${file}] units=${d.scopeAccounting.totalRelevantUnits} absence=${d.scopeAccounting.promotionAbsenceEstablishedUnits} concl=${d.scopeAdequacy.conclusion}`,
        );
      }
    }
    expect(promoted).toEqual([]);
  });
});

/**
 * Family I — benign progression. Hardening that blocks everything is not hardening, so the
 * false-block surface is tracked as explicitly as the false-safe surface.
 */
const benign: Array<[string, string, string[]]> = [
  ["numeric constant", "src/i.ts", ["const RETRY_LIMIT = 4;"]],
  ["arithmetic", "src/i.ts", ["const total = subtotal + tax;"]],
  ["strict equality", "src/i.ts", ["const ok = left === right;"]],
  ["precedence arithmetic", "src/i.ts", ["const count = a + b * c;"]],
  ["concealed source alone", "src/i.ts", ["const p = await getpass('pin');"]],
  [
    "concealed source with length observation",
    "src/i.ts",
    ["const p = await getpass('pin');", "const present = p.length > 0;"],
  ],
  [
    "concealed source with comparison",
    "src/i.ts",
    ["const p = await getpass('pin');", "const same = expected === p;"],
  ],
  ["type-only import", "src/i.ts", ['import type { Command } from "./contracts";']],
  ["rust use declaration", "src/i.rs", ["use std::collections::HashMap"]],
  ["rust numeric constant", "src/i.rs", ["const FRAME_LIMIT: usize = 64;"]],
  ["markdown prose", "docs/i.md", ["Updated the retry ceiling rationale."]],
  ["mdx prose", "docs/i.mdx", ["This paragraph documents the change."]],
  [
    "recognized line comment plus constant",
    "src/i.ts",
    ["// raise the ceiling for slow links", "const RETRY_LIMIT = 4;"],
  ],
  [
    "recognized block comment plus constant",
    "src/i.ts",
    ["/* raise the ceiling */", "const RETRY_LIMIT = 4;"],
  ],
  ["python comment plus constant", "src/i.py", ["# raise the ceiling", "RETRY_LIMIT = 4"]],
  [
    "multiple accounted units",
    "src/i.ts",
    ["const total = subtotal + tax;", "const RETRY_LIMIT = 4;"],
  ],
  ["boolean negation", "src/i.ts", ["const off = !enabled;"]],
  ["ternary of identifiers", "src/i.ts", ["const n = flag ? a : b;"]],
];

describe("Family I — benign progression must survive the hardening", () => {
  it("reports every benign change that failed to progress", () => {
    const blocked: string[] = [];
    for (const [label, file, lines] of benign) {
      const patch = patchFor(file, lines);
      if (trustFor(patch) !== "MERGE_ELIGIBLE") {
        const d = discoverConcerns(patch);
        blocked.push(
          `${label} [${file}] units=${d.scopeAccounting.totalRelevantUnits} absence=${d.scopeAccounting.promotionAbsenceEstablishedUnits} concl=${d.scopeAdequacy.conclusion}`,
        );
      }
    }
    expect(blocked).toEqual([]);
  });

  it("keeps an empty executable change progressive", () => {
    expect(trustFor(patchFor("docs/i.md", ["prose only"]))).toBe("MERGE_ELIGIBLE");
  });
});
