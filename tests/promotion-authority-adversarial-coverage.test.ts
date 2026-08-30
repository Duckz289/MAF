import { describe, expect, it } from "vitest";
import type { AssurancePlan } from "../src/domain/assurance";
import { discoverConcerns } from "../src/domain/concern-discovery";
import { deriveConcernEvidence } from "../src/domain/concern-evidence";
import { deriveTrustState, type QualityReport } from "../src/domain/quality";

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

const replacementPatchFor = (file: string, removed: string[], added: string[]): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
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

/** Family B/C/D/G attacks. None may reach MERGE_ELIGIBLE. */
const attacks: Array<[string, string, string[]]> = [
  // Family B — attach unrelated behavior to each FULL-producing predicate
  [
    "concealed origin + sibling call",
    "src/b.ts",
    ["const p = await getpass('pin');", "const present = p.length > 0;", "ship(p);"],
  ],
  ["concealed origin with dynamic arg", "src/b.ts", ["const p = await getpass(promptFor(user));"]],
  [
    "concealed origin then property write",
    "src/b.ts",
    ["const p = await getpass('pin');", "cache.value = p;"],
  ],
  [
    "observation plus update operator",
    "src/b.ts",
    ["const p = await getpass('pin');", "const present = p.length > 0; tries++;"],
  ],
  [
    "credential literal plus sibling exec",
    "src/b.ts",
    ['const password = "correct-horse-battery";', "exec(request.command);"],
  ],
  ["authorization plus opaque sibling", "src/b.ts", ["if (role === 'admin') {", "audit(request);"]],
  ["authorization with call in condition", "src/b.ts", ["if (checkRole(user)) {"]],
  ["authorization via property read", "src/b.ts", ["if (policy.allowed) {"]],
  [
    "scalar unit plus opaque sibling",
    "src/b.ts",
    ["const total = a + b;", "dispatch(request.payload);"],
  ],

  // Family D — negative domain parity across producers
  ["short credential literal", "src/d.ts", ['const pwd = "abc";']],
  ["template credential literal", "src/d.ts", ["const secret = `abc`;"]],
  ["credential with placeholder-ish short value", "src/d.ts", ['const token = "x1";']],
  ["bare passphrase short", "src/d.ts", ['const passphrase = "pass";']],
  ["session key short", "src/d.ts", ['const session_key = "k1";']],
  ["python short credential", "src/d.py", ["pwd = 'abc'"]],
  [
    "env secret to sink",
    "src/d.ts",
    ["const apiKey = process.env.API_TOKEN;", "console.log(apiKey);"],
  ],

  // Family G — added / removed / replaced
  ["removed control statement", "src/g.ts", []],
  ["removed exec boundary", "src/g.ts", []],
];

const removalAttacks: Array<[string, string, string[]]> = [
  ["removed authorization guard", "src/g.ts", ["if (user.role === 'admin') {"]],
  ["removed exec call", "src/g.ts", ["exec(request.command);"]],
  ["removed credential literal", "src/g.ts", ['const password = "admin";']],
  ["removed comment-shaped decrement", "src/g.ts", ["--lockCount;"]],
];

const replacementAttacks: Array<[string, string, string[], string[]]> = [
  [
    "benign addition laundering removed control",
    "src/g.ts",
    ["if (user.role === 'admin') { deny(); }"],
    ["const RETRY_LIMIT = 4;"],
  ],
  [
    "benign addition laundering removed exec",
    "src/g.ts",
    ["exec(request.command);"],
    ["const total = a + b;"],
  ],
  [
    "replacement inherits only safer side",
    "src/g.ts",
    ['const password = "admin";'],
    ["const RETRY_LIMIT = 4;"],
  ],
];

describe("self-adversarial probe 2: FULL coverage, correlated gates, domain parity, direction", () => {
  it("blocks every added-material attack", () => {
    const promoted: string[] = [];
    for (const [label, file, lines] of attacks) {
      if (lines.length === 0) continue;
      const patch = patchFor(file, lines);
      if (trustFor(patch) === "MERGE_ELIGIBLE") {
        const d = discoverConcerns(patch);
        promoted.push(
          `${label} units=${d.scopeAccounting.totalRelevantUnits} covered=${d.scopeAccounting.concernCoveredUnits} absence=${d.scopeAccounting.promotionAbsenceEstablishedUnits} concl=${d.scopeAdequacy.conclusion}`,
        );
      }
    }
    expect(promoted).toEqual([]);
  });

  it("blocks every removal attack", () => {
    const promoted: string[] = [];
    for (const [label, file, lines] of removalAttacks) {
      const patch = removalPatchFor(file, lines);
      if (trustFor(patch) === "MERGE_ELIGIBLE") promoted.push(label);
    }
    expect(promoted).toEqual([]);
  });

  it("blocks every replacement attack (added benign cannot launder removed material)", () => {
    const promoted: string[] = [];
    for (const [label, file, removed, added] of replacementAttacks) {
      const patch = replacementPatchFor(file, removed, added);
      if (trustFor(patch) === "MERGE_ELIGIBLE") promoted.push(label);
    }
    expect(promoted).toEqual([]);
  });

  it("never emits COMPLETE credential absence for a raised unit outside the scanner domain", () => {
    for (const statement of [
      'const pwd = "abc";',
      'const passphrase = "pass";',
      'const session_key = "k1";',
      'const token = "x1";',
    ]) {
      const patch = patchFor("src/d.ts", [statement]);
      const discovery = discoverConcerns(patch);
      if (!discovery.concerns.some((c) => c.concern === "SECURITY.CREDENTIAL_LITERAL")) continue;
      const evidence = deriveConcernEvidence({
        diffPatch: patch,
        concerns: discovery.concerns,
        candidateId: "c",
        diffDigest: "d",
      });
      for (const record of evidence) {
        if (
          record.concern === "SECURITY.CREDENTIAL_LITERAL" &&
          record.claim === "NEGATIVE_ABSENCE" &&
          record.outcome === "PASS"
        ) {
          expect(`${statement} -> ${record.completeness}`).toBe(`${statement} -> INCOMPLETE`);
        }
      }
    }
  });
});
