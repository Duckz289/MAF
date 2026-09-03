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
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
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
import path from "node:path";
import type { EffectiveConfigReport } from "./effective-config-gate";
import { FIRST_PARTY_AUTH_METHODS, type PinnedExecutable } from "./executable-gate";
import {
  inspectWorktree,
  verifyFrozenArtifacts,
  verifyRunnerFreeze,
  type TagVerificationOptions,
} from "./tag-verification";
import type { CampaignGateDecision } from "./campaign-budget";
import type { SlotState } from "./state-store";

export type GateCheckId =
  | "FROZEN_TAGS"
  | "ANALYSIS_FROZEN"
  | "REMOTE_VERIFICATION_PERFORMED"
  | "RUNNER_FROZEN"
  | "RUNNER_MATCHES_HEAD"
  | "WORKTREE_CLEAN"
  | "MANIFEST_PARAMETERS"
  | "CLAUDE_AUTH"
  | "CLAUDE_EXECUTABLE_PINNED"
  | "PROVIDER_ROUTING"
  | "EFFECTIVE_CLAUDE_CONFIG"
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
  /**
   * The RESULT of the pinned-executable probe, consumed whole.
   *
   * Previously the gate took a loose `auth` object and re-derived its own weaker conclusions from
   * it: it accepted any non-empty `executablePath` (so the bare string "claude" passed) and treated
   * `apiProvider === "firstParty"` as sufficient (so an `api_key` session passed). Meanwhile
   * `executableAuthorizedForScoring` already encoded the stronger rules and went unused. Taking the
   * probe result directly removes the second, weaker implementation entirely -- there is now one
   * authoritative predicate, and the gate cannot drift from it.
   */
  pinnedExecutable: PinnedExecutable;
  routing: {
    externalModelOverrideForwarded: boolean;
    externalBaseUrlOverrideForwarded: boolean;
    externalAuthTokenForwarded: boolean;
    detail: string;
  };
  /** Result of inspecting the CLI's own ACTIVE configuration, not just process environments. */
  effectiveConfig: EffectiveConfigReport;
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

  // The analysis freeze is reported as its own check even though verifyFrozenArtifacts already
  // covers it: "which statistical specification governs this campaign" is a distinct question from
  // "is the suite intact", and an operator reading a refusal needs to see which one failed.
  const analysisCheck = frozen.checks.find((check) => check.tag === ANALYSIS_TAG);
  checks.push({
    id: "ANALYSIS_FROZEN",
    passed: analysisCheck?.status === "OK",
    detail:
      analysisCheck === undefined
        ? `analysis tag ${ANALYSIS_TAG} was not verified`
        : analysisCheck.status === "OK"
          ? `analysis ${ANALYSIS_TAG} v${ANALYSIS_VERSION} verified at ${ANALYSIS_SHA}`
          : analysisCheck.detail,
  });

  // Remote verification is mandatory for a billed run. The previous revision documented this but
  // never enforced it, so a `skipRemote` caller could have reached authorization having proven only
  // local state.
  checks.push({
    id: "REMOTE_VERIFICATION_PERFORMED",
    passed: frozen.remoteChecked,
    detail: frozen.remoteChecked
      ? "frozen tags were verified against origin, not only locally"
      : "remote verification was skipped; a local-only freeze is not durable evidence and cannot " +
        "authorize billed execution",
  });

  const worktree = await inspectWorktree(tagOptions);
  // Runner freeze: exists locally AND remotely, both peeling to the same commit, and that commit is
  // exactly the executing source revision.
  const runnerFreeze = await verifyRunnerFreeze({
    runnerTag: RUNNER_TAG,
    headSha: worktree.headSha,
    options: tagOptions,
  });
  checks.push({
    id: "RUNNER_FROZEN",
    passed: runnerFreeze.ok,
    detail: runnerFreeze.detail,
  });

  checks.push({
    id: "WORKTREE_CLEAN",
    passed: worktree.clean,
    detail: worktree.detail,
  });
  checks.push({
    id: "RUNNER_MATCHES_HEAD",
    // Reported separately so an operator can see WHICH half failed, but derived from the same
    // verification rather than a second, weaker comparison.
    passed: runnerFreeze.ok || runnerFreeze.status === "HEAD_MISMATCH" ? runnerFreeze.ok : false,
    detail:
      runnerFreeze.status === "HEAD_MISMATCH"
        ? runnerFreeze.detail
        : runnerFreeze.ok
          ? `executing source ${worktree.headSha} is exactly the frozen runner revision`
          : `cannot compare: ${runnerFreeze.status}`,
  });

  checks.push(checkManifestParameters(input.manifest));

  // Authentication must be first-party by BOTH provider and method. `api_key` is deliberately not
  // accepted: the frozen experiment is defined over a first-party claude.ai subscription session,
  // and an API-key session is a different provider relationship even when it reports firstParty.
  const pinned = input.pinnedExecutable;
  const authOk = pinned.loggedIn && pinned.firstParty;
  checks.push({
    id: "CLAUDE_AUTH",
    passed: authOk,
    detail: !pinned.loggedIn
      ? pinned.detail
      : authOk
        ? `authenticated first-party (method=${String(pinned.authMethod)})`
        : `authenticated but apiProvider=${String(pinned.apiProvider)} / authMethod=` +
          `${String(pinned.authMethod)} is not an accepted first-party session ` +
          `(${FIRST_PARTY_AUTH_METHODS.join(", ")}); a scoring run under a different provider ` +
          "relationship is not the frozen experiment",
  });

  // The binary that was version- and auth-checked must be the binary that executes, and it must be
  // ABSOLUTE so no spawn repeats a PATH lookup. The first billed preflight version-checked "claude"
  // and then spawned whatever PATH resolved at run time.
  checks.push({
    id: "CLAUDE_EXECUTABLE_PINNED",
    passed: pinned.pinned && pinned.path !== null && pinned.pathIsAbsolute,
    detail:
      pinned.pinned && pinned.pathIsAbsolute
        ? `executable pinned for version, auth and execution: ${String(pinned.path)}` +
          (pinned.version ? ` (${pinned.version})` : "")
        : pinned.detail,
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

  // The check the preflight history proved was missing: process environments can both be spotless
  // while the CLI's own settings file redirects it.
  checks.push({
    id: "EFFECTIVE_CLAUDE_CONFIG",
    passed: input.effectiveConfig.clean,
    detail: input.effectiveConfig.summary,
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

// --------------------------------------------------- provider authorization

/**
 * Unforgeable proof that a specific pair was authorized by a complete gate evaluation.
 *
 * The audit found `executePairedSlots` could reach `runPair` -- and therefore a real provider --
 * without itself requiring any gate decision. The CLI happened not to call it that way, but
 * "the current caller is careful" is not a safety property: a second caller, a refactor, or a test
 * helper reused in production would silently bypass every check. The boundary that spawns the
 * provider must enforce authorization itself.
 *
 * The brand symbol is module-private and never exported, so no code outside this module can
 * construct a value of this type -- not with an object literal, not with a cast that type-checks.
 * The only way to obtain one is `issueProviderAuthorization`, which requires a fully AUTHORIZED
 * decision. That makes this a capability rather than a flag.
 */
declare const PROVIDER_AUTHORIZATION_BRAND: unique symbol;

export interface ProviderAuthorization {
  readonly [PROVIDER_AUTHORIZATION_BRAND]: true;
  /** The complete gate decision this capability was minted from. */
  readonly decision: ExecutionGateDecision;
  /** Campaign this authorization belongs to; prevents reuse against a different campaign. */
  readonly campaignId: string;
  /** Schedule the pair was drawn from; prevents reuse across a re-planned campaign. */
  readonly scheduleDigest: string;
  /** The exact pair authorized. Digests bind suite + protocol + task + arm + replicate. */
  readonly nativeSlotDigest: string;
  readonly mafSlotDigest: string;
  /** The pinned executable this authorization was granted against. */
  readonly executablePath: string;
  readonly issuedAt: string;
}

export interface IssueAuthorizationInput {
  decision: ExecutionGateDecision;
  campaignId: string;
  scheduleDigest: string;
  nativeSlotDigest: string;
  mafSlotDigest: string;
  executablePath: string;
}

/**
 * Mints a provider authorization, or returns null when the gate did not fully pass.
 *
 * Returning null rather than throwing lets a caller report the refusal with the gate's own failure
 * list; `assertAuthorizedForPair` is what turns a missing capability into a hard error at the spawn
 * boundary.
 */
export const issueProviderAuthorization = (
  input: IssueAuthorizationInput,
): ProviderAuthorization | null => {
  if (!input.decision.authorized) return null;
  // The bound executable must be absolute. A capability naming "claude" would authorize a spawn
  // that still performs its own PATH lookup, which is exactly what the binding exists to prevent.
  if (!input.executablePath || !path.isAbsolute(input.executablePath)) return null;
  if (!input.campaignId || !input.scheduleDigest) return null;
  if (!input.nativeSlotDigest || !input.mafSlotDigest) return null;
  return {
    decision: input.decision,
    campaignId: input.campaignId,
    scheduleDigest: input.scheduleDigest,
    nativeSlotDigest: input.nativeSlotDigest,
    mafSlotDigest: input.mafSlotDigest,
    executablePath: input.executablePath,
    issuedAt: new Date().toISOString(),
  } as ProviderAuthorization;
};

export interface AuthorizationContext {
  campaignId: string;
  scheduleDigest: string;
  nativeSlotDigest: string;
  mafSlotDigest: string;
  /**
   * The executable the caller is about to spawn participants with.
   *
   * Required, and required to be absolute. Omitting it previously let `ClaudeCodeAdapter` fall back
   * to its own `"claude"` default and perform a fresh PATH lookup, so the binary that was
   * auth-checked was not necessarily the binary that ran -- the very defect the pinning was
   * introduced to close.
   */
  executablePath: string | undefined;
}

/**
 * Re-validates a capability against the execution it is about to permit.
 *
 * Holding a valid capability is not enough: it must be the capability for THIS pair, in THIS
 * campaign, under THIS schedule. Without that binding, an authorization minted for a cheap pair
 * could be replayed against a different one after the budget had moved on.
 */
export const assertAuthorizedForPair = (
  authorization: ProviderAuthorization | undefined,
  context: AuthorizationContext,
): void => {
  if (!authorization) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: no provider authorization was supplied. A participant may only " +
        "be spawned with a capability minted by a complete execution-gate evaluation " +
        "(issueProviderAuthorization); there is no unauthorized spawn path.",
    );
  }
  assertAuthorizedForProviderCall(authorization.decision);

  // The executable is checked before the identity fields: a spawn that would reach a different
  // binary is unsafe regardless of which pair it was for.
  if (context.executablePath === undefined || context.executablePath === "") {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: no participant executable was supplied. Billed scoring must " +
        "spawn the exact absolute binary the authorization was issued against; allowing the " +
        "adapter to fall back to its default would repeat a PATH lookup and could reach a " +
        "different binary than the one that was version- and auth-checked.",
    );
  }
  if (!path.isAbsolute(context.executablePath)) {
    throw new Error(
      `SCORING_EXECUTION_REFUSED: participant executable "${context.executablePath}" is not an ` +
        "absolute path, so each spawn would repeat a PATH lookup that could resolve elsewhere.",
    );
  }
  if (authorization.executablePath !== context.executablePath) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: this authorization was issued against executable " +
        `"${authorization.executablePath}" but the requested execution would spawn ` +
        `"${context.executablePath}".`,
    );
  }

  const mismatches: string[] = [];
  if (authorization.campaignId !== context.campaignId) {
    mismatches.push(`campaign ${authorization.campaignId} != ${context.campaignId}`);
  }
  if (authorization.scheduleDigest !== context.scheduleDigest) {
    mismatches.push("schedule digest differs");
  }
  if (authorization.nativeSlotDigest !== context.nativeSlotDigest) {
    mismatches.push("NATIVE slot digest differs");
  }
  if (authorization.mafSlotDigest !== context.mafSlotDigest) {
    mismatches.push("MAF slot digest differs");
  }
  if (mismatches.length > 0) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the supplied authorization was issued for a different " +
        `execution and cannot be reused here (${mismatches.join("; ")}).`,
    );
  }
};
