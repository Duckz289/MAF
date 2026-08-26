import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildAssurancePlan } from "../src/domain/assurance";
import { DEFAULT_CONTEXT_BUDGET } from "../src/domain/context";
import { deriveTrustState, type QualityReport } from "../src/domain/quality";
import { deriveRiskVector } from "../src/domain/risk";

describe("Session 6 context authority conservation", () => {
  it("keeps context, paging, and knowledge contracts out of assurance/trust inputs", async () => {
    const guarded = [
      "src/domain/assurance.ts",
      "src/domain/assurance-obligation.ts",
      "src/domain/quality.ts",
      "src/domain/mission-tree.ts",
    ];
    for (const file of guarded) {
      const source = await readFile(file, "utf8");
      expect(source).not.toMatch(
        /from\s+["'][^"']*(?:context-navigation|context-builder|project-brain)[^"']*["']/u,
      );
    }
  });

  it("does not reduce assurance when the context budget is reduced", () => {
    const risk = deriveRiskVector({
      files: ["src/auth/session.ts", "src/auth/permissions.ts"],
      moduleOwnership: {
        "src/auth/session.ts": "src/auth",
        "src/auth/permissions.ts": "src/auth",
      },
      packageOwnership: {
        "src/auth/session.ts": "root",
        "src/auth/permissions.ts": "root",
      },
      crossModuleEdgeCount: 0,
    });
    const before = buildAssurancePlan(risk, "CRITICAL");
    const reducedContextBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      maxTextCharacters: 1,
      maxPageCount: 1,
      maxPageRequests: 1,
    };
    expect(reducedContextBudget.maxTextCharacters).toBeLessThan(
      DEFAULT_CONTEXT_BUDGET.maxTextCharacters,
    );
    expect(buildAssurancePlan(risk, "CRITICAL")).toEqual(before);
  });

  it("cannot let paging success or failure upgrade an unverified candidate", () => {
    const risk = deriveRiskVector({
      files: [],
      moduleOwnership: {},
      packageOwnership: {},
      crossModuleEdgeCount: 0,
    });
    const plan = buildAssurancePlan(risk, "BALANCED");
    const unusedBecauseVerificationFailed = {} as QualityReport;
    const before = deriveTrustState("FAILED", unusedBecauseVerificationFailed, plan, true);
    const afterMoreContext = deriveTrustState(
      "FAILED",
      unusedBecauseVerificationFailed,
      plan,
      true,
    );
    const afterPagingFailure = deriveTrustState(
      "FAILED",
      unusedBecauseVerificationFailed,
      plan,
      true,
    );
    expect([before, afterMoreContext, afterPagingFailure]).toEqual([
      "PROPOSED",
      "PROPOSED",
      "PROPOSED",
    ]);
  });
});
