import type { ExecutionMode, TrustState, VerificationState } from "./types";

export type MissionNodeState = "BLOCKED" | "READY" | "RUNNING" | "DONE" | "CANCELLED";

export interface MissionTrustBinding {
  runId: string;
  candidateId: string;
  candidateDigest: string;
  verificationId: string;
}

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
  /**
   * The candidate's assurance verdict, when one was produced for this node.
   *
   * VerificationState answers "did the trusted verifier pass"; TrustState answers "is there an
   * unresolved assurance obligation against this candidate". They are different questions, and
   * this tree used to gate handoff on the first while its own wording ("verified-only handoff")
   * implied the second. A candidate can be VERIFIED and still carry a deterministic architecture
   * FAIL, an unresolved security obligation, or a required check nothing could establish.
   *
   * Absent means no assurance verdict exists for this node — handoff then falls back to the
   * correctness-only rule the tree has always applied, and says so. Present means the stronger
   * gate applies: only MERGE_ELIGIBLE may be handed on. Nothing is inferred from absence.
   */
  trustState?: TrustState | undefined;
  /** Exact server-owned run/candidate/verification identity supporting the trust verdict. */
  trustBinding?: MissionTrustBinding | undefined;
  /**
   * Explicit declaration that this node predates the trust kernel and can only ever carry
   * correctness evidence (finding H4).
   *
   * Absence of `trustState` used to IMPLY legacy, which made backward compatibility reachable by
   * any new record: an API client that simply omitted the field got the weaker correctness-only
   * handoff rule, and a quality-blocked candidate could enter mission handoff because a field was
   * forgotten. Compatibility is a claim about a record's provenance, so it must be stated, not
   * inferred from a gap.
   *
   * A node with neither `trustState` nor `legacyTrustBasis` is a current record missing its
   * verdict, and fails safe.
   */
  legacyTrustBasis?: boolean | undefined;
  lastModeTransition?:
    | { from: ExecutionMode; to: ExecutionMode; reason: string; evidence: string[] }
    | undefined;
}

/**
 * What a handoff (promote / merge / dependency satisfaction) requires of a node.
 *
 * TRUSTED_CANDIDATE  the node carries an assurance verdict and it must be MERGE_ELIGIBLE.
 * CORRECTNESS_ONLY   the node explicitly declares a legacy trust basis; trusted verification
 *                    passing is all that was ever established, and the handoff says so.
 * UNDECLARED         a current record carries no verdict and no legacy declaration. Nothing is
 *                    established, and nothing is inferred — the handoff is blocked.
 */
export type MissionHandoffBasis = "TRUSTED_CANDIDATE" | "CORRECTNESS_ONLY" | "UNDECLARED";

export const missionHandoffBasis = (node: MissionNode): MissionHandoffBasis => {
  if (node.trustState !== undefined) return "TRUSTED_CANDIDATE";
  return node.legacyTrustBasis === true ? "CORRECTNESS_ONLY" : "UNDECLARED";
};

/**
 * The single handoff predicate every gate in this tree uses. Correctness is necessary in both
 * cases; a node that also carries an assurance verdict must additionally have no unresolved
 * obligation against it.
 */
const handoffBlockedReason = (node: MissionNode): string | undefined => {
  if (node.verificationState !== "VERIFIED") {
    return `verification state is ${node.verificationState}, not VERIFIED`;
  }
  if (node.trustState !== undefined && node.trustState !== "MERGE_ELIGIBLE") {
    return `assurance verdict is ${node.trustState}, not MERGE_ELIGIBLE — a quality-blocked candidate cannot be handed on as trusted`;
  }
  if (node.trustState !== undefined && node.trustBinding === undefined) {
    return "the assurance verdict has no server-owned run/candidate/verification identity binding";
  }
  if (node.trustState === undefined && node.legacyTrustBasis !== true) {
    // Finding H4: a current record with no verdict and no explicit legacy declaration. Falling
    // back to correctness-only here is what let a forgotten field buy the weaker rule, so the
    // missing basis is treated as missing evidence rather than as historical compatibility.
    return "no assurance verdict and no explicit legacy trust basis — a current mission node must declare its trust basis; an omitted field is not a compatibility claim";
  }
  return undefined;
};

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
    const blocked = sources
      .map((node) => ({ node, reason: handoffBlockedReason(node) }))
      .find((entry) => entry.reason !== undefined);
    if (blocked) {
      throw new Error(
        `Verified-only handoff: merged source ${blocked.node.id} is not eligible — ${blocked.reason}`,
      );
    }
    merged.inputs = [...new Set([...merged.inputs, ...sources.flatMap((node) => node.outputs)])];
    this.nodes.set(merged.id, structuredClone(merged));
    this.refreshGates();
  }

  promote(id: string, output: string): void {
    const node = this.requireNode(id);
    const blocked = handoffBlockedReason(node);
    if (blocked !== undefined) {
      throw new Error(`Verified-only handoff: ${id} cannot be promoted — ${blocked}`);
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
      }
    }
    parent.state = "READY";
    const priorMode = parent.executionMode;
    parent.executionMode = "SOLO_NATIVE";
    parent.lastModeTransition = {
      from: priorMode,
      to: "SOLO_NATIVE",
      reason: "parallel child workflow was collapsed by the operator",
      evidence: ["child workflow states were cancelled; their verification evidence was preserved"],
    };
  }

  setVerification(
    id: string,
    state: VerificationState,
    outputs: string[] = [],
    trustState?: TrustState,
    trustBinding?: MissionTrustBinding,
  ): void {
    const node = this.requireNode(id);
    node.verificationState = state;
    if (trustState !== undefined) node.trustState = trustState;
    if (trustBinding !== undefined) node.trustBinding = structuredClone(trustBinding);
    node.outputs = [...outputs];
    node.state = state === "VERIFIED" ? "DONE" : state === "CANCELLED" ? "CANCELLED" : node.state;
    this.refreshGates();
  }

  canRun(id: string): boolean {
    const node = this.requireNode(id);
    return node.dependencyIds.every(
      (dependencyId) => handoffBlockedReason(this.requireNode(dependencyId)) === undefined,
    );
  }

  /**
   * What each node's handoff eligibility currently rests on, for callers that need to SHOW the
   * distinction rather than only enforce it — "tests passed" and "safe to hand on" must not read
   * the same in a UI or a report.
   */
  handoffBasis(): Array<{ id: string; basis: MissionHandoffBasis; blockedReason?: string }> {
    return [...this.nodes.values()].map((node) => {
      const reason = handoffBlockedReason(node);
      return {
        id: node.id,
        basis: missionHandoffBasis(node),
        ...(reason === undefined ? {} : { blockedReason: reason }),
      };
    });
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
