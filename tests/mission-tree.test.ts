import { describe, expect, it } from "vitest";
import { type MissionNode, MissionTree } from "../src/domain/mission-tree";

const node = (id: string, dependencyIds: string[] = [], parentId?: string): MissionNode => ({
  id,
  ...(parentId ? { parentId } : {}),
  dependencyIds,
  state: dependencyIds.length ? "BLOCKED" : "READY",
  executionMode: "GUIDED",
  agent: "fixture",
  model: "native",
  budget: 1,
  inputs: [],
  outputs: [],
  verificationState: "PROPOSED",
  // These fixtures exercise the tree's ORIGINAL correctness-only handoff rule, which since the
  // trust kernel requires an explicit declaration rather than being inferred from an absent
  // trustState (finding H4). Declaring it here keeps these tests about what they test — split,
  // merge, collapse and dependency gating — rather than about the trust basis.
  legacyTrustBasis: true,
});

describe("MissionTree", () => {
  it("enforces verified-only dependency gating", () => {
    const tree = new MissionTree(node("root"));
    tree.split("root", [node("a", [], "root"), node("b", ["a"], "root")]);
    expect(tree.canRun("b")).toBe(false);
    tree.setVerification("a", "VERIFIED", ["artifact://a"]);
    expect(tree.canRun("b")).toBe(true);
    expect(tree.get("b").state).toBe("READY");
  });

  it("rejects merge and promotion of unverified output", () => {
    const tree = new MissionTree(node("root"));
    tree.split("root", [node("a", [], "root"), node("b", [], "root")]);
    expect(() => tree.promote("a", "artifact://a")).toThrow("Verified-only");
    expect(() => tree.merge(["a", "b"], node("merged"))).toThrow("Verified-only");
  });

  it("supports merge and collapse after verification", () => {
    const tree = new MissionTree(node("root"));
    tree.split("root", [node("a", [], "root"), node("b", [], "root")]);
    tree.setVerification("a", "VERIFIED", ["artifact://a"]);
    tree.setVerification("b", "VERIFIED", ["artifact://b"]);
    tree.merge(["a", "b"], node("merged", ["a", "b"]));
    expect(tree.get("merged").inputs).toEqual(["artifact://a", "artifact://b"]);
    tree.collapse("root");
    expect(tree.get("root").executionMode).toBe("SOLO_NATIVE");
  });

  it("collapses workflow state without overwriting child verification evidence", () => {
    const tree = new MissionTree(node("root"));
    tree.split("root", [node("a", [], "root"), node("b", [], "root")]);
    tree.setVerification("a", "FAILED", ["artifact://failed-a"]);
    tree.collapse("root");
    expect(tree.get("a")).toMatchObject({
      state: "CANCELLED",
      verificationState: "FAILED",
      outputs: ["artifact://failed-a"],
    });
    expect(tree.get("root").lastModeTransition).toMatchObject({
      from: "GUIDED",
      to: "SOLO_NATIVE",
      reason: expect.any(String),
      evidence: expect.any(Array),
    });
  });
});
