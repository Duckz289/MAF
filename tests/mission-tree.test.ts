import { describe, expect, it } from "vitest";
import { MissionTree, type MissionNode } from "../src/domain/mission-tree";

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
});
