import type { ExecutionMode, VerificationState } from "./types";

export type MissionNodeState = "BLOCKED" | "READY" | "RUNNING" | "DONE" | "CANCELLED";

export interface MissionNode {
  id: string;
  parentId?: string | undefined;
  dependencyIds: string[];
  state: MissionNodeState;
  executionMode: ExecutionMode;
  agent: string;
  model: string;
  budget: number;
  inputs: string[];
  outputs: string[];
  verificationState: VerificationState;
}

export class MissionTree {
  private readonly nodes = new Map<string, MissionNode>();

  constructor(root: MissionNode) {
    this.nodes.set(root.id, structuredClone(root));
  }

  get(id: string): MissionNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown mission node: ${id}`);
    return structuredClone(node);
  }

  list(): MissionNode[] {
    return [...this.nodes.values()].map((node) => structuredClone(node));
  }

  split(parentId: string, children: MissionNode[]): void {
    this.requireNode(parentId);
    if (children.length < 2) throw new Error("Split requires at least two independent children");
    for (const child of children) {
      if (child.parentId !== parentId) throw new Error("Split child must reference its parent");
      if (this.nodes.has(child.id)) throw new Error(`Duplicate mission node: ${child.id}`);
      this.nodes.set(child.id, structuredClone(child));
    }
    this.refreshGates();
  }

  merge(nodeIds: string[], merged: MissionNode): void {
    if (nodeIds.length < 2) throw new Error("Merge requires at least two nodes");
    const sources = nodeIds.map((id) => this.requireNode(id));
    const unstable = sources.some((node) => node.verificationState !== "VERIFIED");
    if (unstable) throw new Error("Verified-only handoff: every merged source must be VERIFIED");
    merged.inputs = [...new Set([...merged.inputs, ...sources.flatMap((node) => node.outputs)])];
    this.nodes.set(merged.id, structuredClone(merged));
    this.refreshGates();
  }

  promote(id: string, output: string): void {
    const node = this.requireNode(id);
    if (node.verificationState !== "VERIFIED") {
      throw new Error("Verified-only handoff: only VERIFIED output can be promoted");
    }
    if (!node.outputs.includes(output)) node.outputs.push(output);
    node.state = "DONE";
    this.refreshGates();
  }

  collapse(parentId: string): void {
    const parent = this.requireNode(parentId);
    for (const node of this.nodes.values()) {
      if (node.parentId === parentId) {
        node.state = "CANCELLED";
        node.verificationState = "CANCELLED";
      }
    }
    parent.state = "READY";
    parent.executionMode = "SOLO_NATIVE";
  }

  setVerification(id: string, state: VerificationState, outputs: string[] = []): void {
    const node = this.requireNode(id);
    node.verificationState = state;
    node.outputs = [...outputs];
    node.state = state === "VERIFIED" ? "DONE" : state === "CANCELLED" ? "CANCELLED" : node.state;
    this.refreshGates();
  }

  canRun(id: string): boolean {
    const node = this.requireNode(id);
    return node.dependencyIds.every(
      (dependencyId) => this.requireNode(dependencyId).verificationState === "VERIFIED",
    );
  }

  private refreshGates(): void {
    for (const node of this.nodes.values()) {
      if (node.state === "DONE" || node.state === "RUNNING" || node.state === "CANCELLED") continue;
      node.state = this.canRun(node.id) ? "READY" : "BLOCKED";
    }
  }

  private requireNode(id: string): MissionNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Unknown mission node: ${id}`);
    return node;
  }
}
