// The gate every billed scoring invocation must pass.
//
// Design intent: make a paid scoring call structurally impossible rather than merely discouraged.
// The runner does not construct a participant executor at all unless this gate returns AUTHORIZED,
// and the gate cannot return AUTHORIZED while `maf-scoring-runner-v2` does not exist -- which it
// does not, and must not, until an independent audit creates it. So during development the billed
// path is unreachable by construction, not by convention.
//
// RUNNER v2. Incident maf-scoring-incident-2026-09-03-v1 proved that "the runner tag does not exist
// yet" protects PRODUCTION and nothing else: the freeze ceremony itself removes that condition, and
// a test which had assumed it then drove this gate to AUTHORIZED for real. So the gate also carries
// checks whose truth does not depend on any external tag state -- PROVIDER_IDENTITY,
// TEST_CONTEXT_ISOLATION and RUNNER_V1_NOT_SELECTED -- and mints a capability bound to an
// unforgeable provider identity rather than to a bare path string.
//
// WHAT THE INDEPENDENT AUDIT CHANGED
// ----------------------------------
// `ProviderAuthorization` used the same `declare const BRAND` trick as `ProviderIdentity`: a
// compile-time-only marker, erased at runtime, so a cast object literal was accepted by the spawn
// boundary. Worse, `issueProviderAuthorization` accepted any object with `authorized: true` as its
// gate decision, so the capability could be minted from a hand-written decision that no gate had
// ever produced. Three things changed:
//
//   * `ExecutionGateDecision` is now runtime-authentic. Only `evaluateExecutionGate` mints one, and
//     `issueProviderAuthorization` refuses anything else -- a forged decision cannot start the chain.
//   * `ProviderAuthorization` is runtime-authentic by the same module-private `WeakSet` mechanism,
//     so a literal, a spread, an `Object.assign` clone and a JSON round-trip are all refused.
//   * the capability now binds the FULL set the audit named: campaign, schedule, both slot digests,
//     the exact absolute executable, the provider identity object, the execution context object, the
//     frozen-authority digest and the budget-state digest. Any one of them differing is a refusal.
//
// The incident record is a MANDATORY frozen authority here, exactly as the suite and the protocol
// are (INCIDENT_FROZEN). Runner v2 exists because of that incident; a paid campaign that cannot
// produce the record governing its own runner is not reproducible evidence.
//
// Every check fails CLOSED. An inconclusive check (git unavailable, auth unreadable, corrupt state)
// is a refusal, never a pass, because the cost of wrongly proceeding is real money spent against a
// frozen experiment that cannot be re-run identically.

import {
  ANALYSIS_SHA,
  ANALYSIS_TAG,
  ANALYSIS_VERSION,
  FROZEN_PARAMETERS,
  INCIDENT_SHA,
  INCIDENT_TAG,
  KNOWN_SOURCE_METADATA_NOTE,
  PROTOCOL_FREEZE_AUTHORITY,
  PROTOCOL_V2_SHA,
  PROTOCOL_V2_TAG,
  RUNNER_TAG,
  RUNNER_V1_SHA,
  RUNNER_V1_STATUS,
  RUNNER_V1_TAG,
  RUNNER_VERSION,
  SUITE_SHA,
  SUITE_TAG,
} from "./frozen-refs";
import path from "node:path";
import type { EffectiveConfigReport } from "./effective-config-gate";
import { FIRST_PARTY_AUTH_METHODS, type PinnedExecutable } from "./executable-gate";
import {
  canonicalFrozenAuthorityDigest,
  inspectWorktree,
  observedFrozenAuthorityDigest,
  verifyFrozenArtifacts,
  verifyIncidentFreeze,
  verifyRunnerFreeze,
  type TagVerificationOptions,
} from "./tag-verification";
import { campaignBudgetDigest, type CampaignGateDecision } from "./campaign-budget";
import {
  assertProviderIdentityForSpawn,
  isAuthenticProviderIdentity,
  type ProviderIdentity,
} from "./provider-identity";
import {
  assertAuthenticExecutionContext,
  isAuthenticExecutionContext,
  type ExecutionContext,
} from "./execution-context";
import type { SlotState } from "./state-store";

export type GateCheckId =
  | "FROZEN_TAGS"
  | "ANALYSIS_FROZEN"
  | "INCIDENT_FROZEN"
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
  | "EXECUTION_CONTEXT_AUTHENTIC"
  | "PROVIDER_IDENTITY"
  | "TEST_CONTEXT_ISOLATION"
  | "RUNNER_V1_NOT_SELECTED"
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
  /** The execution context this decision was reached in. Bound into any capability minted from it. */
  executionContext: ExecutionContext;
  /** The provider identity this decision was reached about, or null when none was established. */
  providerIdentity: ProviderIdentity | null;
  /** Digest of the frozen authorities as ACTUALLY OBSERVED, including the incident record. */
  freezeAuthorityDigest: string;
  /** True only when the incident tag verified local == remote == the pinned commit. */
  incidentFrozen: boolean;
  summary: string;
}

/**
 * Runtime authenticity registry for gate decisions.
 *
 * Module-private, never exported, never fed a caller-supplied object. Only `evaluateExecutionGate`
 * (and the internal test-support seam, which mints one the same way for in-process tests) adds to
 * it. Without this, `issueProviderAuthorization` would accept `{ authorized: true }` -- an object
 * that no gate produced -- as the start of the capability chain.
 */
const AUTHENTIC_DECISIONS = new WeakSet<object>();

/** Runtime authenticity predicate for gate decisions. Reading is safe to export; adding is not. */
export const isAuthenticExecutionGateDecision = (value: unknown): value is ExecutionGateDecision =>
  typeof value === "object" && value !== null && AUTHENTIC_DECISIONS.has(value);

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
  /**
   * The unforgeable identity of the provider that would be spawned, or null when none could be
   * established. Null is a REFUSAL, never a licence to resolve one: the incident's root cause was
   * precisely that absent provider configuration fell through to the real executable.
   */
  providerIdentity: ProviderIdentity | null;
  /** Why identity could not be established, when it could not. Reported verbatim to the operator. */
  providerIdentityDetail: string;
  /**
   * Whether git/tag state was INJECTED rather than read from the real repository.
   *
   * Used by TEST_CONTEXT_ISOLATION: a test may drive the billed path only against simulated freeze
   * state. Real repository state plus billed confirmation is the exact combination that caused the
   * incident, and it is a refusal in its own right.
   */
  gitStateInjected: boolean;
  /**
   * REQUIRED, and authenticated.
   *
   * The audit found this was optional and defaulted to an environment sniff, which made mutable
   * ambient state the trust root. It is now an explicitly constructed value that the gate proves the
   * provenance of before reading its `kind`.
   */
  executionContext: unknown;
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
  // The execution context is proven BEFORE any check reads its kind. An unauthentic context is not
  // a failing check -- it is a caller error that must not produce a decision object at all, because
  // a decision carries its context forward into every capability minted from it.
  assertAuthenticExecutionContext(input.executionContext, "evaluateExecutionGate");
  const context: ExecutionContext = input.executionContext;

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
      ? `suite ${SUITE_TAG}=${SUITE_SHA}, protocol ${PROTOCOL_V2_TAG}=${PROTOCOL_V2_SHA} and ` +
        `incident ${INCIDENT_TAG}=${INCIDENT_SHA} verified`
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

  // THE INCIDENT IS A MANDATORY AUTHORITY. Verified in full and on its own: present locally,
  // published on origin, peeling on BOTH sides to the pinned commit, with the remote lookup actually
  // performed. `verifyIncidentFreeze` treats a skipped remote as REMOTE_NOT_CHECKED, which is never
  // OK -- so `--skip-remote` cannot narrow what was proven about the record that justifies this
  // runner's existence.
  const incidentFreeze = await verifyIncidentFreeze(tagOptions);
  checks.push({
    id: "INCIDENT_FROZEN",
    passed: incidentFreeze.ok,
    detail: incidentFreeze.ok
      ? `${incidentFreeze.detail}; Runner v2 exists because of this incident, and its record is a ` +
        "required frozen authority for paid execution (it supplies no observations)"
      : incidentFreeze.detail,
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

  // ------------------------------------------------- RUNNER v2 structural checks
  //
  // The checks below are the ones the incident proves must exist. Unlike every check above them,
  // none consults external repository state, so no freeze ceremony, tag creation, or future
  // repository change can invalidate the assumption they rest on.

  const identity = input.providerIdentity;

  // The context reached here already proven authentic, so this check can only report -- but it
  // reports, because an operator reading a refusal needs to see which world the gate believed it
  // was in and where that belief came from.
  checks.push({
    id: "EXECUTION_CONTEXT_AUTHENTIC",
    passed: true,
    detail:
      `${context.detail} Ambient environment is advisory here and cannot change this ` +
      "classification; it can only force a refusal when it contradicts a PRODUCTION claim.",
  });

  // Identity must be present AND runtime-authentic. A forged object reaching this input is a
  // failing check rather than a thrown error, so the operator sees the complete gate report.
  const identityAuthentic = identity !== null && isAuthenticProviderIdentity(identity);
  checks.push({
    id: "PROVIDER_IDENTITY",
    passed: identityAuthentic,
    detail:
      identity === null
        ? `no provider identity could be established: ${input.providerIdentityDetail}`
        : !identityAuthentic
          ? "the supplied provider identity was not created by the provider-identity factories. A " +
            "hand-written object, a spread, an Object.assign clone and a JSON round-trip are all " +
            "refused: authenticity is a runtime registration, not a TypeScript brand."
          : identity.context !== context
            ? `provider identity ${identity.kind} was established in a different execution ` +
              "context than this gate is evaluating"
            : identity.detail,
  });

  // The interlock, restated at gate level so a refusal is legible before anything is minted. In the
  // incident this is the check that would have failed while all the others passed.
  const identityUsable = identityAuthentic && identity !== null && identity.context === context;
  const testIsolationOk =
    context.kind === "PRODUCTION"
      ? !identityUsable || identity.kind === "REAL_PROVIDER_EXECUTION"
      : identityUsable &&
        identity.kind === "TEST_DOUBLE_PROVIDER_EXECUTION" &&
        (!input.billedConfirmed || input.gitStateInjected);
  checks.push({
    id: "TEST_CONTEXT_ISOLATION",
    passed: testIsolationOk,
    detail:
      context.kind === "PRODUCTION"
        ? identityUsable && identity.kind === "TEST_DOUBLE_PROVIDER_EXECUTION"
          ? "a TEST_DOUBLE provider identity was presented in a PRODUCTION context; simulated " +
            "observations must never be recorded as paid scoring evidence"
          : `${context.detail} REAL_PROVIDER_EXECUTION is admissible.`
        : !identityUsable || identity.kind !== "TEST_DOUBLE_PROVIDER_EXECUTION"
          ? `${context.detail} But the provider identity is ` +
            `${identity === null ? "NONE" : identityAuthentic ? identity.kind : "UNAUTHENTIC"}. ` +
            "Under test only an approved TEST_DOUBLE may be spawned -- see incident " +
            `${INCIDENT_TAG} (${INCIDENT_SHA}).`
          : input.billedConfirmed && !input.gitStateInjected
            ? "billed confirmation was supplied under test against REAL repository git state. A " +
              "test may exercise the billed path only against injected freeze state, so that its " +
              "behaviour cannot change when a real tag is created -- which is exactly how " +
              `${INCIDENT_TAG} occurred.`
            : `${context.detail} Approved TEST_DOUBLE with ` +
              `${input.gitStateInjected ? "injected" : "real"} git state.`,
  });

  // Runner v1 must never be selected for scoring again, by tag or by executing revision.
  const headIsRunnerV1 = worktree.headSha === RUNNER_V1_SHA;
  const runnerTagIsV1 = (RUNNER_TAG as string) === RUNNER_V1_TAG;
  checks.push({
    id: "RUNNER_V1_NOT_SELECTED",
    passed: !headIsRunnerV1 && !runnerTagIsV1,
    detail: runnerTagIsV1
      ? `the configured runner tag is ${RUNNER_V1_TAG}, which is ${RUNNER_V1_STATUS}`
      : headIsRunnerV1
        ? `the executing revision is ${RUNNER_V1_SHA} (${RUNNER_V1_TAG}), which is ` +
          `${RUNNER_V1_STATUS}. Its test architecture permitted a real provider spawn from a test; ` +
          "scoring requires Runner v2 or later."
        : `executing revision is not ${RUNNER_V1_TAG} (${RUNNER_V1_STATUS}); scoring runs under ` +
          `${RUNNER_TAG} v${RUNNER_VERSION}`,
  });

  checks.push({
    id: "BILLED_CONFIRMATION",
    passed: input.billedConfirmed,
    detail: input.billedConfirmed
      ? "operator supplied explicit billed-scoring confirmation"
      : "no --confirm-billed-scoring flag: plan/validate only, zero provider calls",
  });

  const failures = checks.filter((check) => !check.passed);
  const decision: ExecutionGateDecision = {
    authorized: failures.length === 0,
    checks,
    failures,
    protocolFreezeAuthority: PROTOCOL_FREEZE_AUTHORITY,
    protocolFrozen: true,
    knownSourceMetadataNote: KNOWN_SOURCE_METADATA_NOTE,
    executionContext: context,
    providerIdentity: identityUsable ? identity : null,
    // Computed from the peeled commits verification ACTUALLY SAW, so a decision reached in a
    // different frozen world carries a different digest and cannot be replayed in this one.
    freezeAuthorityDigest: observedFrozenAuthorityDigest(frozen.checks),
    incidentFrozen: incidentFreeze.ok,
    summary:
      failures.length === 0
        ? `all ${checks.length} gates passed; billed scoring is authorized under runner ${RUNNER_TAG} v${RUNNER_VERSION}`
        : `${failures.length} of ${checks.length} gates failed; billed scoring is REFUSED`,
  };
  AUTHENTIC_DECISIONS.add(decision);
  return decision;
};

/**
 * INTERNAL -- registers a decision built by the test-support seam.
 *
 * Re-exported by `lib/internal/test-support.ts` so in-process tests can exercise the capability
 * chain without a full repository probe. Production sources never name this symbol;
 * `tests/scoring-runner-v2-isolation.test.ts` asserts they do not.
 */
export const __INTERNAL_registerExecutionGateDecision = (
  decision: ExecutionGateDecision,
): ExecutionGateDecision => {
  AUTHENTIC_DECISIONS.add(decision);
  return decision;
};

/**
 * The single place a participant may be spawned from.
 *
 * Callers must route every provider invocation through this, so "authorized" is impossible to
 * bypass by forgetting a check at one call site.
 */
export const assertAuthorizedForProviderCall = (decision: ExecutionGateDecision): void => {
  if (!isAuthenticExecutionGateDecision(decision)) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the execution-gate decision presented was not produced by " +
        "evaluateExecutionGate. An object asserting `authorized: true` proves nothing: a decision " +
        "is authentic only by runtime registration at the moment the gates were actually run.",
    );
  }
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
 * without itself requiring any gate decision. The CLI happened not to call it that way, but "the
 * current caller is careful" is not a safety property: a second caller, a refactor, or a test helper
 * reused in production would silently bypass every check. The boundary that spawns the provider must
 * enforce authorization itself.
 *
 * Authenticity is a module-private `WeakSet` registration performed by `issueProviderAuthorization`
 * and nowhere else. The compile-time brand below is retained only to stop accidental structural
 * typing; it is explicitly NOT the mechanism, because a brand is erased at runtime and the audit
 * found exactly that hole.
 */
declare const PROVIDER_AUTHORIZATION_BRAND: unique symbol;

export interface ProviderAuthorization {
  readonly [PROVIDER_AUTHORIZATION_BRAND]: true;
  /** The complete, runtime-authentic gate decision this capability was minted from. */
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
  /**
   * The unforgeable provider identity this capability was minted from.
   *
   * Runner v1 bound the capability to a path STRING, which says where a binary is but nothing about
   * what it is. A test that reached this point with the real Claude executable's path therefore held
   * a perfectly valid capability. v2 binds the identity object itself.
   */
  readonly providerIdentity: ProviderIdentity;
  /** The execution context object this capability was minted in. Compared by reference. */
  readonly executionContext: ExecutionContext;
  /** Which frozen authorities were in force. A capability from another frozen world is refused. */
  readonly freezeAuthorityDigest: string;
  /** The budget state at issue time. A capability minted with more headroom cannot be replayed. */
  readonly budgetDigest: string;
  readonly issuedAt: string;
}

/** Runtime authenticity registry for capabilities. Module-private, exactly like the others. */
const AUTHENTIC_AUTHORIZATIONS = new WeakSet<object>();

/** Runtime authenticity predicate for capabilities. Reading is safe to export; adding is not. */
export const isAuthenticProviderAuthorization = (value: unknown): value is ProviderAuthorization =>
  typeof value === "object" && value !== null && AUTHENTIC_AUTHORIZATIONS.has(value);

export interface IssueAuthorizationInput {
  /** Must be runtime-authentic AND authorized. A hand-written decision cannot start the chain. */
  decision: ExecutionGateDecision;
  /** The budget decision this pair is being authorized against, bound as a digest. */
  campaignGate: CampaignGateDecision;
  campaignId: string;
  scheduleDigest: string;
  nativeSlotDigest: string;
  mafSlotDigest: string;
  /**
   * REQUIRED. The capability cannot be minted from a bare path: an identity must have been
   * established first, which is impossible for an unconfigured test and impossible for the real
   * provider under test.
   */
  providerIdentity: ProviderIdentity;
  /** REQUIRED and authenticated; must be the very context the decision and identity were made in. */
  executionContext: unknown;
}

/**
 * Mints a provider authorization, or returns null when any precondition fails.
 *
 * Returning null rather than throwing lets a caller report the refusal alongside the gate's own
 * failure list; `assertAuthorizedForPair` is what turns a missing capability into a hard error at
 * the spawn boundary.
 */
export const issueProviderAuthorization = (
  input: IssueAuthorizationInput,
): ProviderAuthorization | null => {
  // The chain starts with a decision that a real gate evaluation produced. Everything else in this
  // function is meaningless if this is skipped, because a forged decision can claim anything.
  if (!isAuthenticExecutionGateDecision(input.decision)) return null;
  if (!input.decision.authorized) return null;

  if (!isAuthenticExecutionContext(input.executionContext)) return null;
  const executionContext: ExecutionContext = input.executionContext;
  if (input.decision.executionContext !== executionContext) return null;

  const identity = input.providerIdentity;
  if (!isAuthenticProviderIdentity(identity)) return null;
  // The identity must belong to this context and be the one the gate actually decided about.
  if (identity.context !== executionContext) return null;
  if (input.decision.providerIdentity !== identity) return null;

  // The bound executable must be absolute. A capability naming "claude" would authorize a spawn
  // that still performs its own PATH lookup, which is exactly what the binding exists to prevent.
  if (!identity.executablePath || !path.isAbsolute(identity.executablePath)) return null;

  // A capability is minted against a budget state that can actually afford the pair.
  if (!input.campaignGate || !input.campaignGate.authorized) return null;

  if (!input.campaignId || !input.scheduleDigest) return null;
  if (!input.nativeSlotDigest || !input.mafSlotDigest) return null;

  const authorization: ProviderAuthorization = Object.freeze({
    decision: input.decision,
    campaignId: input.campaignId,
    scheduleDigest: input.scheduleDigest,
    nativeSlotDigest: input.nativeSlotDigest,
    mafSlotDigest: input.mafSlotDigest,
    executablePath: identity.executablePath,
    providerIdentity: identity,
    executionContext,
    freezeAuthorityDigest: input.decision.freezeAuthorityDigest,
    budgetDigest: campaignBudgetDigest(input.campaignGate),
    issuedAt: new Date().toISOString(),
  }) as ProviderAuthorization;
  AUTHENTIC_AUTHORIZATIONS.add(authorization);
  return authorization;
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
  /** REQUIRED and authenticated; compared by object reference against the capability's own. */
  executionContext: unknown;
  /**
   * The frozen authorities the CALLER believes are in force, recomputed independently.
   *
   * Defaults to this runner revision's pinned constants, so a capability minted against a repository
   * whose tags differ from the pinned ones is refused here rather than trusted.
   */
  freezeAuthorityDigest?: string;
  /** The budget state the caller is executing under. A stale capability mismatches and is refused. */
  budgetDigest?: string;
  /** Injected so a test can drive the ambient-contradiction rule deterministically. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Re-validates a capability against the execution it is about to permit.
 *
 * Holding a valid capability is not enough: it must be the capability for THIS pair, in THIS
 * campaign, under THIS schedule, THIS frozen world, THIS budget state and THIS execution context.
 * Without those bindings, an authorization minted for a cheap pair could be replayed against a
 * different one after the budget had moved on.
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
  // RUNTIME AUTHENTICITY FIRST. Reading any field of a forged capability and reasoning about it
  // would be exactly the mistake the audit found: the fields of a hand-written object say whatever
  // its author wanted.
  if (!isAuthenticProviderAuthorization(authorization)) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the provider authorization presented at the spawn boundary was " +
        "not minted by issueProviderAuthorization. A hand-written object, an object spread, an " +
        "Object.assign clone and a JSON round-trip all produce a DIFFERENT object and are all " +
        "refused, whatever their fields claim.",
    );
  }

  assertAuthenticExecutionContext(context.executionContext, "the provider spawn boundary");
  if (authorization.executionContext !== context.executionContext) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: this authorization was minted in a different execution context " +
        `(${authorization.executionContext.kind}, origin ` +
        `${authorization.executionContext.origin}) than the one presented at the spawn boundary ` +
        `(${context.executionContext.kind}, origin ${context.executionContext.origin}).`,
    );
  }

  assertAuthorizedForProviderCall(authorization.decision);

  // THE PROVIDER INTERLOCK, checked before anything else about this pair. A spawn that would reach
  // the real provider from a test is unsafe no matter which pair it was authorized for, which
  // campaign it belongs to, or how completely the freeze gates passed -- the incident is the proof.
  assertProviderIdentityForSpawn(authorization.providerIdentity, {
    executablePath: context.executablePath,
    executionContext: context.executionContext,
    ...(context.environment ? { environment: context.environment } : {}),
  });

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
  const expectedFreeze = context.freezeAuthorityDigest ?? canonicalFrozenAuthorityDigest();
  if (authorization.freezeAuthorityDigest !== expectedFreeze) {
    mismatches.push(
      "frozen-authority digest differs: this capability was minted under a different set of " +
        "frozen suite/protocol/analysis/incident identities than the one now in force",
    );
  }
  if (context.budgetDigest !== undefined && authorization.budgetDigest !== context.budgetDigest) {
    mismatches.push(
      "budget-state digest differs: this capability was minted against a different campaign spend " +
        "state, so replaying it could authorize a pair the remaining ceiling no longer covers",
    );
  }
  if (mismatches.length > 0) {
    throw new Error(
      "SCORING_EXECUTION_REFUSED: the supplied authorization was issued for a different " +
        `execution and cannot be reused here (${mismatches.join("; ")}).`,
    );
  }
};
