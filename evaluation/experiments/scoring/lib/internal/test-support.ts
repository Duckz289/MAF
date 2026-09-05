// INTERNAL TEST-SUPPORT SEAM -- the only route to a TEST execution context.
//
// WHY THIS FILE EXISTS AS A SEPARATE DIRECTORY
// --------------------------------------------
// The audit's Repair 3 requires that TEST vs PRODUCTION trust be EXPLICIT rather than inferred from
// mutable ambient environment, and that the production CLI have no way to construct a TEST context:
// no `--test-mode`, no environment variable, no flag an operator could reach for.
//
// So the two halves live apart. `run-scoring.ts` calls `createProductionExecutionContext()` and
// nothing else; the TEST factory is here, under `lib/internal/`, which no production source imports.
// That separation is not a naming convention -- `tests/scoring-runner-v2-isolation.test.ts` scans the
// production sources and fails if any of them names this directory or the `__INTERNAL_` symbols it
// re-exports, so the property is checked on every run.
//
// HOW A TEST GETS A TEST CONTEXT INTO THE PRODUCTION COMMAND
// ---------------------------------------------------------
// The CLI accepts `--test-fixture <module>`, and that module must EXPORT an execution context which
// the CLI then verifies is runtime-authentic and TEST. Because the fixture module and the CLI are
// loaded into the same process, they share this module instance and therefore the same private
// registry. A fixture that fabricates `{ kind: "TEST" }` does not get one: it gets a refusal.
//
// This is deliberately not a hole. An operator who pointed `--test-fixture` at an arbitrary module
// gets TEST_SEAM_INCOMPLETE, and even a module that did import this file yields a strictly LESS
// capable world: a TEST context can only ever spawn an approved test double, never the real
// provider. The dangerous direction -- turning a test into a production run -- has no route at all.

import {
  __INTERNAL_mintTestExecutionContext,
  createProductionExecutionContext,
  type ExecutionContext,
} from "../execution-context";
import {
  __INTERNAL_registerExecutionGateDecision,
  type ExecutionGateDecision,
  type GateCheck,
} from "../execution-gate";
import { PROTOCOL_FREEZE_AUTHORITY } from "../frozen-refs";
import { canonicalFrozenAuthorityDigest } from "../tag-verification";
import type { ProviderIdentity } from "../provider-identity";

/**
 * Mints an authentic TEST execution context.
 *
 * `origin` is recorded on the context and printed in every refusal that mentions it, so a surprising
 * TEST classification can always be traced back to the code that asked for one.
 */
export const createTestExecutionContext = (
  origin = "internal-test-support",
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionContext => __INTERNAL_mintTestExecutionContext(origin, environment);

/**
 * Mints an authentic PRODUCTION execution context for in-process tests of the production path.
 *
 * This grants a test nothing dangerous. The spawn boundary re-checks the LIVE environment, and a
 * PRODUCTION context presented under a visible test harness is a contradiction that fails closed --
 * so a test holding one still cannot reach a real provider. It exists so tests can prove that the
 * production branch behaves correctly, which is otherwise unobservable.
 */
export const createProductionExecutionContextForTest = (
  origin = "internal-test-support-production",
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionContext => createProductionExecutionContext(origin, environment);

/**
 * Builds an authentic, fully-AUTHORIZED gate decision without running a repository probe.
 *
 * In-process tests of the capability chain (issue -> bind -> spawn boundary) need a decision that
 * `issueProviderAuthorization` will accept. Before this seam existed they hand-wrote
 * `{ authorized: true }` -- which is precisely the forgery the audit flagged, and which the
 * production code now refuses. Rather than reopening that hole for everyone, the ability to register
 * a decision lives here, where production sources cannot reach it.
 *
 * The decision is still bound to a REAL context and a REAL provider identity, so nothing minted from
 * it can escape the interlock: a TEST context still admits only an approved test double.
 */
export const mintTestExecutionGateDecision = (input: {
  executionContext: ExecutionContext;
  providerIdentity: ProviderIdentity | null;
  authorized?: boolean;
  checks?: GateCheck[];
  freezeAuthorityDigest?: string;
  incidentFrozen?: boolean;
}): ExecutionGateDecision => {
  const checks = input.checks ?? [];
  const failures = checks.filter((check) => !check.passed);
  const authorized = input.authorized ?? failures.length === 0;
  const decision: ExecutionGateDecision = {
    authorized,
    checks,
    failures,
    protocolFreezeAuthority: PROTOCOL_FREEZE_AUTHORITY,
    protocolFrozen: true,
    knownSourceMetadataNote: "test-support decision",
    executionContext: input.executionContext,
    providerIdentity: input.providerIdentity,
    freezeAuthorityDigest: input.freezeAuthorityDigest ?? canonicalFrozenAuthorityDigest(),
    incidentFrozen: input.incidentFrozen ?? true,
    summary: authorized
      ? "test-support decision: all gates treated as passed"
      : "test-support decision: REFUSED",
  };
  return __INTERNAL_registerExecutionGateDecision(decision);
};
