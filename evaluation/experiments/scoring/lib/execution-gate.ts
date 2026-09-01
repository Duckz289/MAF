// The gate every billed scoring invocation must pass.
//
// Design intent: make a paid scoring call structurally impossible rather than merely discouraged.
// The runner does not construct a participant executor at all unless this gate returns AUTHORIZED,
// and the gate cannot return AUTHORIZED while `maf-scoring-runner-v1` does not exist -- which it
// does not, and must not, until an independent audit creates it. So during development the billed
// path is unreachable by construction, not by convention.
//
// Every check fails CLOSED. An inconclusive check (git unavailable, auth unreadable, corrupt state)
// is a refusal, never a pass, because the cost of wrongly proceeding is real money spent against a
// frozen experiment that cannot be re-run identically.

import {
  FROZEN_PARAMETERS,
  KNOWN_SOURCE_METADATA_NOTE,
  PROTOCOL_FREEZE_AUTHORITY,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
  RUNNER_VERSION,
  SUITE_SHA,
  SUITE_TAG,
} from "./frozen-refs";
import {
  inspectWorktree,
  resolveRunnerTagSha,
  verifyFrozenArtifacts,
  type TagVerificationOptions,
} from "./tag-verification";
import type { CampaignGateDecision } from "./campaign-budget";
import type { SlotState } from "./state-store";

export type GateCheckId =
  | "FROZEN_TAGS"
  | "RUNNER_FROZEN"
  | "RUNNER_MATCHES_HEAD"
  | "WORKTREE_CLEAN"
  | "MANIFEST_PARAMETERS"
  | "CLAUDE_AUTH"
  | "PROVIDER_ROUTING"
  | "CAMPAIGN_BUDGET"
  | "STATE_STORE_INTEGRITY"
  | "NO_AMBIGUOUS_RECOVERY"
  | "BILLED_CONFIRMATION";

export interface GateCheck {
  id: GateCheckId;
  passed: boolean;
  detail: string;
}

export interface ExecutionGateDecision {
  authorized: boolean;
  checks: GateCheck[];
  failures: GateCheck[];
  protocolFreezeAuthority: typeof PROTOCOL_FREEZE_AUTHORITY;
  protocolFrozen: true;
  knownSourceMetadataNote: string;
  summary: string;
}

export interface ManifestParameters {
  model: string;
  provider: string;
  effort: string;
  timeoutMs: number;
  perRunCeilingUsd: number;
  runsPerTask: number;
  totalScoringRunsPlanned: number;
  suiteSha: string;
  suiteTag: string;
}

export interface ExecutionGateInput {
  repoRoot: string;
  /** Explicit operator confirmation. Absent means plan/validate only. */
  billedConfirmed: boolean;
  manifest: ManifestParameters;
  slotStates: readonly SlotState[];
  campaignGate: CampaignGateDecision;
  auth: { loggedIn: boolean; detail: string };
  routing: {
    externalModelOverrideForwarded: boolean;
    externalBaseUrlOverrideForwarded: boolean;
    externalAuthTokenForwarded: boolean;
    detail: string;
  };
  git?: TagVerificationOptions["git"];
  skipRemote?: boolean;
}

/** Compares the loaded manifest against the pinned frozen parameters, field by field. */
export const checkManifestParameters = (manifest: ManifestParameters): GateCheck => {
  const mismatches: string[] = [];
  const compare = (field: string, actual: unknown, expected: unknown): void => {
    if (actual !== expected)
      mismatches.push(`${field}: manifest=${String(actual)} frozen=${String(expected)}`);
  };
  compare("model", manifest.model, FROZEN_PARAMETERS.model);
  compare("provider", manifest.provider, FROZEN_PARAMETERS.provider);
  compare("effort", manifest.effort, FROZEN_PARAMETERS.effort);
  compare("timeoutMs", manifest.timeoutMs, FROZEN_PARAMETERS.timeoutMs);
  compare("perRunCeilingUsd", manifest.perRunCeilingUsd, FROZEN_PARAMETERS.perRunCeilingUsd);
  compare("runsPerTask", manifest.runsPerTask, FROZEN_PARAMETERS.runsPerTask);
  compare(
    "totalScoringRunsPlanned",
    manifest.totalScoringRunsPlanned,
    FROZEN_PARAMETERS.totalScoringRuns,
  );
  compare("frozenSuite.sha", manifest.suiteSha, SUITE_SHA);
  compare("frozenSuite.tag", manifest.suiteTag, SUITE_TAG);
  return {
    id: "MANIFEST_PARAMETERS",
    passed: mismatches.length === 0,
    detail:
      mismatches.length === 0
        ? "manifest parameters match the frozen protocol exactly"
        : `manifest disagrees with the frozen protocol: ${mismatches.join("; ")}`,
  };
};

export const evaluateExecutionGate = async (
  input: ExecutionGateInput,
): Promise<ExecutionGateDecision> => {
  const checks: GateCheck[] = [];
  const tagOptions: TagVerificationOptions = {
    repoRoot: input.repoRoot,
    ...(input.git ? { git: input.git } : {}),
    ...(input.skipRemote ? { skipRemote: input.skipRemote } : {}),
  };

  const frozen = await verifyFrozenArtifacts(tagOptions);
  checks.push({
    id: "FROZEN_TAGS",
    passed: frozen.ok,
    detail: frozen.ok
      ? `suite ${SUITE_TAG}=${SUITE_SHA} and protocol ${PROTOCOL_V2_TAG}=${PROTOCOL_V2_SHA} verified`
      : frozen.failures.join("; "),
  });

  const runnerSha = await resolveRunnerTagSha(RUNNER_TAG, tagOptions);
  checks.push({
    id: "RUNNER_FROZEN",
    passed: runnerSha !== null,
    detail:
      runnerSha === null
        ? `runner tag ${RUNNER_TAG} does not exist. The scoring runner must be independently ` +
          "audited and frozen before it may spend money; until then billed scoring is refused."
        : `runner tag ${RUNNER_TAG} resolves to ${runnerSha}`,
  });

  const worktree = await inspectWorktree(tagOptions);
  checks.push({
    id: "WORKTREE_CLEAN",
    passed: worktree.clean,
    detail: worktree.detail,
  });
  checks.push({
    id: "RUNNER_MATCHES_HEAD",
    passed: runnerSha !== null && worktree.headSha !== null && runnerSha === worktree.headSha,
    detail:
      runnerSha === null
        ? "cannot compare: the runner is not frozen"
        : worktree.headSha === null
          ? "cannot compare: HEAD could not be resolved"
          : runnerSha === worktree.headSha
            ? `executing source ${worktree.headSha} is exactly the frozen runner revision`
            : `executing source ${worktree.headSha} is NOT the frozen runner revision ${runnerSha}`,
  });

  checks.push(checkManifestParameters(input.manifest));

  checks.push({
    id: "CLAUDE_AUTH",
    passed: input.auth.loggedIn,
    detail: input.auth.detail,
  });

  const routingClean =
    !input.routing.externalModelOverrideForwarded &&
    !input.routing.externalBaseUrlOverrideForwarded &&
    !input.routing.externalAuthTokenForwarded;
  checks.push({
    id: "PROVIDER_ROUTING",
    passed: routingClean,
    detail: routingClean
      ? `no alternate provider routing reaches the participant (${input.routing.detail})`
      : "alternate ANTHROPIC_* routing would reach the participant; the frozen provider is not guaranteed",
  });

  checks.push({
    id: "CAMPAIGN_BUDGET",
    passed: input.campaignGate.authorized,
    detail: input.campaignGate.detail,
  });

  const corruptSlots = input.slotStates.filter((state) => state.status === "CORRUPT");
  checks.push({
    id: "STATE_STORE_INTEGRITY",
    passed: corruptSlots.length === 0,
    detail:
      corruptSlots.length === 0
        ? "every inspected slot record parsed and checksummed cleanly"
        : `${corruptSlots.length} slot(s) hold corrupt records: ${corruptSlots.map((s) => s.slotId).join(", ")}`,
  });

  const ambiguous = input.slotStates.filter((state) => state.status === "RECOVERY_REQUIRED");
  checks.push({
    id: "NO_AMBIGUOUS_RECOVERY",
    passed: ambiguous.length === 0,
    detail:
      ambiguous.length === 0
        ? "no slot holds a possibly-billed attempt awaiting adjudication"
        : `${ambiguous.length} slot(s) have a possibly-billed attempt with no recorded outcome and ` +
          `require human adjudication first: ${ambiguous.map((s) => s.slotId).join(", ")}`,
  });

  checks.push({
    id: "BILLED_CONFIRMATION",
    passed: input.billedConfirmed,
    detail: input.billedConfirmed
      ? "operator supplied explicit billed-scoring confirmation"
      : "no --confirm-billed-scoring flag: plan/validate only, zero provider calls",
  });

  const failures = checks.filter((check) => !check.passed);
  return {
    authorized: failures.length === 0,
    checks,
    failures,
    protocolFreezeAuthority: PROTOCOL_FREEZE_AUTHORITY,
    protocolFrozen: true,
    knownSourceMetadataNote: KNOWN_SOURCE_METADATA_NOTE,
    summary:
      failures.length === 0
        ? `all ${checks.length} gates passed; billed scoring is authorized under runner ${RUNNER_TAG} v${RUNNER_VERSION}`
        : `${failures.length} of ${checks.length} gates failed; billed scoring is REFUSED`,
  };
};

/**
 * The single place a participant may be spawned from.
 *
 * Callers must route every provider invocation through this, so "authorized" is impossible to
 * bypass by forgetting a check at one call site.
 */
export const assertAuthorizedForProviderCall = (decision: ExecutionGateDecision): void => {
  if (!decision.authorized) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: ${decision.summary}\n` +
        decision.failures.map((f) => `  - ${f.id}: ${f.detail}`).join("\n"),
    );
  }
};
