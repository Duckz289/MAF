import { describe, expect, it } from "vitest";
import {
  connectionStatusLabel,
  isNavigationSelected,
  matchesRunFilter,
  qualityPreferenceDescription,
} from "../src/web/presentation";
import type { Run } from "../src/web/types";
import { formatCost } from "../src/web/utils";

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run-1",
  state: "RUNNING",
  executionMode: "GUIDED",
  verificationState: "PROPOSED",
  agent: "claude-code",
  model: "native",
  provider: "native",
  repositoryPath: "C:/repo",
  revision: "HEAD",
  updatedAt: "2026-08-19T00:00:00.000Z",
  changedFiles: [],
  cost: { total: 0 },
  task: "Fix authorization",
  currentPhase: "Agent execution",
  desiredMode: "GUIDED",
  effectiveMode: "GUIDED",
  modeExplanation: {
    reason: "Initial mode",
    desiredMode: "GUIDED",
    effectiveMode: "GUIDED",
    latestSignals: {},
    timeline: [],
  },
  operationalStatus: "RUNNING",
  ...overrides,
});

describe("frontend presentation rules", () => {
  it("keeps route selection scoped to the active product area", () => {
    expect(isNavigationSelected("/", "/")).toBe(true);
    expect(isNavigationSelected("/projects/project-1", "/projects")).toBe(true);
    expect(isNavigationSelected("/runs/new", "/projects")).toBe(false);
  });

  it("filters active, attention and verified task states", () => {
    expect(matchesRunFilter(run(), "ACTIVE")).toBe(true);
    expect(
      matchesRunFilter(run({ state: "FAILED", operationalStatus: "FAILED" }), "ATTENTION"),
    ).toBe(true);
    expect(
      matchesRunFilter(
        run({ verificationState: "VERIFIED", operationalStatus: "VERIFIED" }),
        "VERIFIED",
      ),
    ).toBe(true);
    expect(
      matchesRunFilter(
        run({
          state: "COMPLETED",
          verificationState: "VERIFIED",
          operationalStatus: "ASSURANCE_BLOCKED",
        }),
        "VERIFIED",
      ),
    ).toBe(false);
    expect(matchesRunFilter(run({ operationalStatus: "ASSURANCE_BLOCKED" }), "ATTENTION")).toBe(
      true,
    );
  });

  it("never renders unavailable provider cost as zero dollars", () => {
    expect(formatCost(0)).toBe("Chi phí chưa khả dụng");
    expect(formatCost(0)).not.toContain("$0.00");
  });

  it("describes quality as a preference and keeps connection checks honest", () => {
    expect(qualityPreferenceDescription("BALANCED")).toContain("Mặc định");
    expect(connectionStatusLabel("UNKNOWN", false)).toBe("Chưa kiểm tra");
    expect(connectionStatusLabel("UNKNOWN", true)).toBe("Đã tìm thấy CLI");
  });
});
