import crypto from "node:crypto";
import type { QualityCheckState, QualityProvenance, QualityReport } from "./quality";
import type { RiskLevel, RiskVector } from "./risk";
import type { Artifact, Run, Task, TrustState, Verification } from "./types";

export type CiConclusion = "PENDING" | "PASS" | "FAIL" | "CANCELLED";

export interface DeliveryHandoff {
  schemaVersion: 1;
  id: string;
  projectId: string;
  runId: string;
  candidateId: string;
  candidateDigest: string;
  baseRevision: string;
  /** Null until an external delivery system creates a commit for the patch candidate. */
  headRevision: string | null;
  changedFiles: string[];
  verification: { id: string; state: "VERIFIED" };
  trustState: TrustState;
  quality: Record<string, { state: QualityCheckState; provenance: QualityProvenance }>;
  knownWarnings: Array<{ dimension: string; state: Exclude<QualityCheckState, "PASS"> }>;
  evidenceRefs: string[];
  budget: {
    mode: "ADVISORY" | "HARD";
    limitUsd: number | null;
    recordedCostUsd: number;
  };
  policy: { ciRequired: boolean; riskLevel: RiskLevel; autoMergeAllowed: false };
  candidateQuality: "READY" | "BLOCKED";
  createdAt: string;
}

export interface CiEvidence {
  schemaVersion: 1;
  id: string;
  handoffId: string;
  provider: string;
  externalRunId: string;
  observedAt: string;
  conclusion: CiConclusion;
  candidateId: string;
  candidateDigest: string;
  baseRevision: string;
  headRevision: string | null;
  checks: Array<{ name: string; conclusion: CiConclusion }>;
  /** Opaque provider-owned reference. Never command output, credentials, or logs. */
  evidenceRef: string;
}

export interface DeliveryDecision {
  handoff: DeliveryHandoff;
  candidateQuality: "READY" | "BLOCKED";
  ciStatus: CiConclusion | "NOT_CHECKED" | "NOT_REQUIRED";
  ciHeadRevision: string | null;
  mergeEligibility: "ELIGIBLE" | "PENDING" | "BLOCKED";
  mergeAuthority: "EXTERNAL_APPROVAL_REQUIRED";
  autoMergeAllowed: false;
  reasons: string[];
}

export interface BuildDeliveryHandoffInput {
  id: string;
  projectId: string;
  run: Run;
  task: Task;
  candidate: Artifact;
  verification: Verification;
  qualityReport: QualityReport;
  riskVector: RiskVector;
}

const safeString = (value: unknown, max = 4_000): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const qualityDimensions = [
  "Correctness",
  "Architecture",
  "Maintainability",
  "Security",
  "Performance",
  "Resilience",
  "TestQuality",
  "DebtDelta",
] as const;
const qualityStates: QualityCheckState[] = [
  "PASS",
  "WARN",
  "FAIL",
  "UNKNOWN",
  "NOT_CHECKED",
  "NOT_REQUIRED",
];
const qualityProvenance: QualityProvenance[] = ["DETERMINISTIC", "MEASURED", "PENDING_CHECKER"];

const aggregateRisk = (risk: RiskVector): RiskLevel =>
  Object.values(risk).some((entry) => entry.level === "HIGH")
    ? "HIGH"
    : Object.values(risk).some((entry) => entry.level === "MEDIUM")
      ? "MEDIUM"
      : "LOW";

export const buildDeliveryHandoff = (input: BuildDeliveryHandoffInput): DeliveryHandoff => {
  const digest = input.candidate.digest;
  const baseRevision = input.candidate.metadata.baseRevision;
  if (
    input.run.state !== "COMPLETED" ||
    input.run.verificationState !== "VERIFIED" ||
    input.verification.state !== "VERIFIED" ||
    input.verification.candidateId !== input.candidate.id ||
    // An explicit negative authority decision is terminal for delivery. Canonical normalized-local
    // evidence also needs the full environment binding; legacy adapter records may still be
    // retained as blocked delivery evidence, but they cannot pass the mission promotion boundary.
    input.verification.authority?.authorized === false ||
    (input.verification.type === "normalized-local" &&
      (!input.verification.environment || input.verification.authority?.authorized !== true)) ||
    !digest ||
    typeof baseRevision !== "string" ||
    !input.run.trustState
  ) {
    throw new Error("Delivery handoff requires a terminal verified candidate and resolved base");
  }
  const quality = Object.fromEntries(
    Object.entries(input.qualityReport).map(([dimension, result]) => [
      dimension,
      { state: result.state, provenance: result.provenance },
    ]),
  );
  const knownWarnings = Object.entries(input.qualityReport)
    .filter(([, result]) => result.state !== "PASS" && result.state !== "NOT_REQUIRED")
    .map(([dimension, result]) => ({
      dimension,
      state: result.state as Exclude<QualityCheckState, "PASS">,
    }));
  return {
    schemaVersion: 1,
    id: input.id,
    projectId: input.projectId,
    runId: input.run.id,
    candidateId: input.candidate.id,
    candidateDigest: digest,
    baseRevision,
    headRevision: null,
    changedFiles: [...input.run.changedFiles],
    verification: { id: input.verification.id, state: "VERIFIED" },
    trustState: input.run.trustState,
    quality,
    knownWarnings,
    evidenceRefs: [
      `artifact:${input.candidate.id}`,
      `verification:${input.verification.id}`,
      `run:${input.run.id}`,
    ],
    budget: {
      mode: input.task.budget?.mode ?? "ADVISORY",
      limitUsd: input.task.budget?.limitUsd ?? null,
      recordedCostUsd: input.run.cost.total,
    },
    policy: {
      ciRequired: true,
      riskLevel: aggregateRisk(input.riskVector),
      autoMergeAllowed: false,
    },
    candidateQuality: input.run.trustState === "MERGE_ELIGIBLE" ? "READY" : "BLOCKED",
    createdAt: input.run.completedAt ?? input.run.updatedAt,
  };
};

export const deliveryHandoffDigest = (handoff: DeliveryHandoff): string =>
  crypto.createHash("sha256").update(JSON.stringify(handoff)).digest("hex");

export const assertDeliveryHandoff: (value: unknown) => asserts value is DeliveryHandoff = (
  value,
) => {
  if (!value || typeof value !== "object") throw new Error("Malformed delivery handoff");
  const handoff = value as Partial<DeliveryHandoff>;
  if (
    handoff.schemaVersion !== 1 ||
    !safeString(handoff.id) ||
    !safeString(handoff.projectId) ||
    !safeString(handoff.runId) ||
    !safeString(handoff.candidateId) ||
    !/^[a-f0-9]{64}$/u.test(handoff.candidateDigest ?? "") ||
    !safeString(handoff.baseRevision) ||
    (handoff.headRevision !== null && !safeString(handoff.headRevision)) ||
    !Array.isArray(handoff.changedFiles) ||
    handoff.changedFiles.length > 2_000 ||
    handoff.changedFiles.some((file) => !safeString(file)) ||
    handoff.verification?.state !== "VERIFIED" ||
    !safeString(handoff.verification.id) ||
    ![
      "PROPOSED",
      "CORRECTNESS_VERIFIED",
      "QUALITY_VERIFIED",
      "DURABLE_VERIFIED",
      "MERGE_ELIGIBLE",
    ].includes(handoff.trustState ?? "") ||
    !handoff.quality ||
    typeof handoff.quality !== "object" ||
    Object.keys(handoff.quality).length !== qualityDimensions.length ||
    qualityDimensions.some((dimension) => {
      const result = handoff.quality?.[dimension];
      return (
        !result ||
        !qualityStates.includes(result.state) ||
        !qualityProvenance.includes(result.provenance)
      );
    }) ||
    !Array.isArray(handoff.knownWarnings) ||
    handoff.knownWarnings.length > qualityDimensions.length ||
    handoff.knownWarnings.some(
      (warning) =>
        !qualityDimensions.includes(warning?.dimension as (typeof qualityDimensions)[number]) ||
        !qualityStates.includes(warning?.state) ||
        warning.state === "NOT_REQUIRED",
    ) ||
    !Array.isArray(handoff.evidenceRefs) ||
    handoff.evidenceRefs.length > 20 ||
    handoff.evidenceRefs.some((ref) => !/^(artifact|verification|run):[^\s]{1,4000}$/u.test(ref)) ||
    !handoff.budget ||
    !["ADVISORY", "HARD"].includes(handoff.budget.mode) ||
    (handoff.budget.limitUsd !== null &&
      (!Number.isFinite(handoff.budget.limitUsd) || handoff.budget.limitUsd < 0)) ||
    !Number.isFinite(handoff.budget.recordedCostUsd) ||
    handoff.budget.recordedCostUsd < 0 ||
    !handoff.policy ||
    handoff.policy.autoMergeAllowed !== false ||
    handoff.policy.ciRequired !== true ||
    !["LOW", "MEDIUM", "HIGH"].includes(handoff.policy.riskLevel) ||
    !["READY", "BLOCKED"].includes(handoff.candidateQuality ?? "") ||
    !safeString(handoff.createdAt) ||
    !Number.isFinite(Date.parse(handoff.createdAt))
  ) {
    throw new Error("Malformed delivery handoff");
  }
};

export const assertCiEvidence: (value: unknown) => asserts value is CiEvidence = (value) => {
  if (!value || typeof value !== "object") throw new Error("Malformed CI evidence");
  const evidence = value as Partial<CiEvidence>;
  if (
    evidence.schemaVersion !== 1 ||
    !safeString(evidence.id) ||
    !safeString(evidence.handoffId) ||
    !safeString(evidence.provider, 200) ||
    !safeString(evidence.externalRunId, 500) ||
    !safeString(evidence.observedAt) ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    !["PENDING", "PASS", "FAIL", "CANCELLED"].includes(evidence.conclusion ?? "") ||
    !safeString(evidence.candidateId) ||
    !/^[a-f0-9]{64}$/u.test(evidence.candidateDigest ?? "") ||
    !safeString(evidence.baseRevision) ||
    (evidence.headRevision !== null && !safeString(evidence.headRevision)) ||
    !Array.isArray(evidence.checks) ||
    evidence.checks.some(
      (check) =>
        !safeString(check?.name, 500) ||
        !["PENDING", "PASS", "FAIL", "CANCELLED"].includes(check?.conclusion),
    ) ||
    !safeString(evidence.evidenceRef, 2_000) ||
    (evidence.conclusion === "PASS" &&
      (evidence.headRevision === null ||
        !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/u.test(evidence.headRevision) ||
        evidence.checks.length === 0 ||
        evidence.checks.some((check) => check.conclusion !== "PASS")))
  ) {
    throw new Error("Malformed CI evidence");
  }
};

export const deriveDeliveryDecision = (
  handoff: DeliveryHandoff,
  evidence: CiEvidence[],
): DeliveryDecision => {
  assertDeliveryHandoff(handoff);
  let externalHead: string | null = handoff.headRevision;
  for (const entry of evidence) {
    assertCiEvidence(entry);
    if (
      entry.handoffId !== handoff.id ||
      entry.candidateId !== handoff.candidateId ||
      entry.candidateDigest !== handoff.candidateDigest ||
      entry.baseRevision !== handoff.baseRevision ||
      (handoff.headRevision !== null && entry.headRevision !== handoff.headRevision)
    ) {
      throw new Error("CI evidence is stale or not bound to this delivery handoff");
    }
    if (externalHead !== null && entry.headRevision !== null && entry.headRevision !== externalHead)
      throw new Error("CI provider run head revision changed across observations");
    externalHead ??= entry.headRevision;
  }
  const latest = evidence
    .toSorted(
      (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id),
    )
    .at(-1);
  const ciStatus = handoff.policy.ciRequired
    ? (latest?.conclusion ?? "NOT_CHECKED")
    : "NOT_REQUIRED";
  const reasons: string[] = [];
  let mergeEligibility: DeliveryDecision["mergeEligibility"];
  if (handoff.candidateQuality !== "READY") {
    mergeEligibility = "BLOCKED";
    reasons.push("candidate quality evidence has not reached READY");
  } else if (ciStatus === "PASS" || ciStatus === "NOT_REQUIRED") {
    mergeEligibility = "ELIGIBLE";
    reasons.push("candidate quality and required CI evidence are satisfied");
  } else if (ciStatus === "FAIL" || ciStatus === "CANCELLED") {
    mergeEligibility = "BLOCKED";
    reasons.push(`required CI evidence is ${ciStatus}`);
  } else {
    mergeEligibility = "PENDING";
    reasons.push("required external CI evidence has not passed");
  }
  reasons.push("merge authority remains external; MAF does not perform the merge");
  return {
    handoff,
    candidateQuality: handoff.candidateQuality,
    ciStatus,
    ciHeadRevision: externalHead,
    mergeEligibility,
    mergeAuthority: "EXTERNAL_APPROVAL_REQUIRED",
    autoMergeAllowed: false,
    reasons,
  };
};
