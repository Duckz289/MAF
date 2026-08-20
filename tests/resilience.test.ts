import { describe, expect, it } from "vitest";

import {
  deriveResiliencePosture,
  deriveResilienceRelevance,
  type ResilienceMeasurement,
} from "../src/domain/resilience";

/** A minimal unified diff adding lines to one file. */
const patchFor = (file: string, added: string[], removed: string[] = []): string =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 1,1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

const measured = (
  scenarios: Array<{ scenario: string; outcome: "PASSED" | "FAILED"; exitCode?: number }>,
  overrides: Partial<ResilienceMeasurement> = {},
): ResilienceMeasurement => ({
  state: "EXECUTED",
  candidateId: "candidate-1",
  diffDigest: "digest-1",
  scenarios: scenarios.map((scenario) => ({
    scenario: scenario.scenario as never,
    outcome: scenario.outcome,
    ...(scenario.exitCode !== undefined ? { exitCode: scenario.exitCode } : {}),
    evidence: ["scenario command exited 0"],
  })),
  evidence: ["scenario(s) executed with the configured trusted command"],
  ...overrides,
});

describe("deriveResilienceRelevance", () => {
  it("derives the network scenario family from an outbound dependency call in the diff", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/api/client.ts", ["const res = await fetch(url);"]),
      false,
    );
    expect(relevance.scenarios).toEqual([
      "HIGH_LATENCY",
      "TIMEOUT",
      "CONNECTION_RESET",
      "MALFORMED_UPSTREAM_RESPONSE",
      "RATE_LIMITING",
    ]);
    expect(relevance.evidence.join(" ")).toContain("outbound dependency");
  });

  it("recognizes WebSocket and SDK-client dependency shapes as network boundaries", () => {
    for (const line of [
      "const socket = new WebSocket(url);",
      "const client = new DynamoDBClient({ region });",
      "const api = new GraphQLClient(endpoint);",
    ]) {
      const relevance = deriveResilienceRelevance(patchFor("src/api/client.ts", [line]), false);
      expect(relevance.scenarios).toContain("TIMEOUT");
    }
  });

  it("marks a binary patch on a code path uninspectable and never grants the relevance-empty PASS", () => {
    const patch = [
      "--- a/src/native/engine.ts",
      "+++ b/src/native/engine.ts",
      "GIT binary patch",
      "literal 1234",
      "zcmVwZ^=n",
    ].join("\n");
    const relevance = deriveResilienceRelevance(patch, false);
    expect(relevance.uninspectable).toBe(true);
    expect(relevance.scenarios).toEqual([]);
    const posture = deriveResiliencePosture(undefined, "candidate-1", "digest-1", relevance);
    expect(posture.state).toBe("NOT_CHECKED");
    expect(posture.evidence.join(" ")).toContain("uninspectable");
  });

  it("a binary asset outside evidence paths does not make relevance uninspectable", () => {
    const patch = [
      "--- a/assets/logo.png",
      "+++ b/assets/logo.png",
      "GIT binary patch",
      "literal 1234",
      "zcmVwZ^=n",
    ].join("\n");
    const relevance = deriveResilienceRelevance(patch, false);
    expect(relevance.uninspectable).toBe(false);
  });

  it("derives DUPLICATE_REQUEST from a consistency-critical write path", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/store/orders.ts", ["await db.transaction(async (tx) => {});"]),
      false,
    );
    expect(relevance.scenarios).toContain("DUPLICATE_REQUEST");
  });

  it("derives OUT_OF_ORDER_RESPONSE from a concurrent completion path", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/api/batch.ts", ["const results = await Promise.all(jobs);"]),
      false,
    );
    expect(relevance.scenarios).toContain("OUT_OF_ORDER_RESPONSE");
  });

  it("forces the interleaving scenarios when the assurance plan requires CONCURRENCY", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/domain/pure.ts", ["export const add = (a: number, b: number) => a + b;"]),
      true,
    );
    expect(relevance.scenarios).toContain("DUPLICATE_REQUEST");
    expect(relevance.scenarios).toContain("OUT_OF_ORDER_RESPONSE");
    expect(relevance.evidence.join(" ")).toContain("CONCURRENCY");
  });

  it("is not evidence: comments naming fault scenarios never derive relevance", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/domain/pure.ts", [
        "// TODO: handle timeout, retry, and connection reset here",
        "export const x = 1;",
      ]),
      false,
    );
    expect(relevance.scenarios).toEqual([]);
    expect(relevance.evidence.join(" ")).toContain("no production-like failure scenario");
  });

  it("is not evidence: a fault-suggestive filename with ordinary code derives nothing", () => {
    const relevance = deriveResilienceRelevance(
      patchFor("src/api/timeout-retry-handler.ts", ["export const plain = true;"]),
      false,
    );
    expect(relevance.scenarios).toEqual([]);
  });

  it("ignores test, fixture, script, and non-code paths", () => {
    for (const file of [
      "tests/client.test.ts",
      "src/fixtures/client.ts",
      "scripts/fetch-things.js",
      "docs/architecture.md",
    ]) {
      const relevance = deriveResilienceRelevance(
        patchFor(file, ["const res = await fetch(url);"]),
        false,
      );
      expect(relevance.scenarios).toEqual([]);
    }
  });
});

describe("deriveResiliencePosture", () => {
  const networkRelevance = deriveResilienceRelevance(
    patchFor("src/api/client.ts", ["const res = await fetch(url);"]),
    false,
  );

  it("returns a deterministic PASS when no scenario is relevant to the diff", () => {
    const empty = deriveResilienceRelevance(
      patchFor("src/domain/pure.ts", ["const x = 1;"]),
      false,
    );
    const posture = deriveResiliencePosture(undefined, "candidate-1", "digest-1", empty);
    expect(posture.state).toBe("PASS");
    expect(posture.evidence.join(" ")).toContain("no production-like failure scenario is relevant");
  });

  it("is NOT_CHECKED when relevant scenarios exist but no measurement was produced", () => {
    const posture = deriveResiliencePosture(undefined, "candidate-1", "digest-1", networkRelevance);
    expect(posture.state).toBe("NOT_CHECKED");
  });

  it("is NOT_CHECKED when the measurement is not bound to the current candidate/digest", () => {
    for (const wrong of [
      measured(
        networkRelevance.scenarios.map((scenario) => ({ scenario, outcome: "PASSED" })),
        {
          candidateId: "candidate-other",
        },
      ),
      measured(
        networkRelevance.scenarios.map((scenario) => ({ scenario, outcome: "PASSED" })),
        {
          diffDigest: "digest-other",
        },
      ),
    ]) {
      expect(
        deriveResiliencePosture(wrong, "candidate-1", "digest-1", networkRelevance).state,
      ).toBe("NOT_CHECKED");
    }
  });

  it("is NOT_CHECKED when a relevant scenario was never executed", () => {
    const partial = measured([{ scenario: "TIMEOUT", outcome: "PASSED" }]);
    const posture = deriveResiliencePosture(partial, "candidate-1", "digest-1", networkRelevance);
    expect(posture.state).toBe("NOT_CHECKED");
    expect(posture.evidence.join(" ")).toContain("never executed");
  });

  it("is NOT_CHECKED when the verifier itself reported NOT_CHECKED", () => {
    const posture = deriveResiliencePosture(
      {
        state: "NOT_CHECKED",
        candidateId: "candidate-1",
        diffDigest: "digest-1",
        scenarios: [],
        evidence: ["no resilience verification specification was configured"],
      },
      "candidate-1",
      "digest-1",
      networkRelevance,
    );
    expect(posture.state).toBe("NOT_CHECKED");
    expect(posture.evidence.join(" ")).toContain("no resilience verification specification");
  });

  it("FAILs on any failed scenario, with the exit code in the evidence", () => {
    // A write path that is both consistency-critical and concurrent: exactly two relevant scenarios.
    const relevance = deriveResilienceRelevance(
      patchFor("src/store/orders.ts", [
        "await db.transaction(async (tx) => {});",
        "const results = await Promise.all(writes);",
      ]),
      false,
    );
    expect(relevance.scenarios.sort()).toEqual(["DUPLICATE_REQUEST", "OUT_OF_ORDER_RESPONSE"]);
    const measurement = measured([
      { scenario: "DUPLICATE_REQUEST", outcome: "PASSED" },
      { scenario: "OUT_OF_ORDER_RESPONSE", outcome: "FAILED", exitCode: 1 },
    ]);
    const posture = deriveResiliencePosture(measurement, "candidate-1", "digest-1", relevance);
    expect(posture.state).toBe("FAIL");
    expect(posture.evidence.join(" ")).toContain("OUT_OF_ORDER_RESPONSE FAILED (exit 1)");
  });

  it("PASSes only when every relevant scenario executed and exited 0, and never claims production verification", () => {
    const scenarios = networkRelevance.scenarios.map((scenario) => ({
      scenario,
      outcome: "PASSED" as const,
    }));
    const posture = deriveResiliencePosture(
      measured(scenarios),
      "candidate-1",
      "digest-1",
      networkRelevance,
    );
    expect(posture.state).toBe("PASS");
    expect(posture.evidence.join(" ")).toContain("not production verification");
  });
});
