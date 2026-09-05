// Shared helper for tests that need an APPROVED test-double provider identity.
//
// There is deliberately no shortcut here. This calls the same `approveTestDoubleProvider` the
// production command calls, against the same on-disk fake CLI, and fails loudly if approval is
// refused. A test helper that fabricated an identity would reintroduce exactly the hole Runner v2
// closes -- authenticity is a module-private runtime registration precisely so that "just make one
// for the test" is not available to anyone, including this file.
//
// The execution context comes from the INTERNAL test-support seam
// (evaluation/experiments/scoring/lib/internal/test-support.ts), which is the only route to a TEST
// context anywhere in the tree. Note what that means in practice: a test cannot hand the boundary a
// `{ kind: "TEST" }` literal and be believed, and neither can this helper.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveTestDoubleProvider,
  type ProviderIdentity,
} from "../../evaluation/experiments/scoring/lib/provider-identity";
import {
  createTestExecutionContext,
  mintTestExecutionGateDecision,
} from "../../evaluation/experiments/scoring/lib/internal/test-support";
import type { ExecutionContext } from "../../evaluation/experiments/scoring/lib/execution-context";
import {
  issueProviderAuthorization,
  type ExecutionGateDecision,
  type ProviderAuthorization,
} from "../../evaluation/experiments/scoring/lib/execution-gate";
import {
  evaluateCampaignGate,
  type CampaignGateDecision,
} from "../../evaluation/experiments/scoring/lib/campaign-budget";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository's canonical fake Claude CLI, carrying the test-double marker. */
export const FAKE_CLAUDE_CLI = path.resolve(here, "..", "fixtures", "fake-claude-cli.mjs");

/**
 * A single authentic TEST context shared by helpers in one test file.
 *
 * Shared on purpose: the spawn boundary compares contexts by object REFERENCE, so a helper that
 * minted a fresh one per call would produce capabilities that cannot be presented together. Tests
 * that want to prove the cross-context refusal mint a second one explicitly.
 */
export const testExecutionContext: ExecutionContext = createTestExecutionContext(
  "tests/helpers/test-double-provider",
);

/** Mints an additional, DIFFERENT authentic TEST context, for cross-context refusal tests. */
export const anotherTestExecutionContext = (origin = "tests/helpers/other"): ExecutionContext =>
  createTestExecutionContext(origin);

/**
 * Approves a test-double provider, throwing with the refusal reason if it cannot be approved.
 *
 * Defaults to the repository's fake CLI, which lives under tests/fixtures/ and is therefore inside a
 * declared test-controlled fixture root.
 */
export const approvedTestDouble = async (
  executablePath: string = FAKE_CLAUDE_CLI,
  context: ExecutionContext = testExecutionContext,
): Promise<ProviderIdentity> => {
  const outcome = await approveTestDoubleProvider({ executablePath, context });
  if (!outcome.approved) {
    throw new Error(
      `test-double provider ${executablePath} was NOT approved (${outcome.reason}): ${outcome.detail}`,
    );
  }
  return outcome.identity;
};

/** A campaign budget decision with ample headroom, for capability-chain tests. */
export const authorizedCampaignGate = (): CampaignGateDecision =>
  evaluateCampaignGate({ states: [], ceilingUsd: 1000, perRunCeilingUsd: 8 });

/**
 * An AUTHENTIC, fully-authorized gate decision bound to a real context and identity.
 *
 * Before the internal seam existed, tests hand-wrote `{ authorized: true }` and
 * `issueProviderAuthorization` accepted it -- the forgery the audit flagged. Production code now
 * refuses that, so the ability to register a decision lives in `lib/internal/`, out of production
 * reach, rather than being reopened for every caller.
 */
export const authenticDecision = (
  providerIdentity: ProviderIdentity | null,
  context: ExecutionContext = testExecutionContext,
): ExecutionGateDecision =>
  mintTestExecutionGateDecision({ executionContext: context, providerIdentity });

/** Mints a real capability for a pair, or throws with why it could not be minted. */
export const authorizationFor = (input: {
  identity: ProviderIdentity;
  campaignId: string;
  scheduleDigest: string;
  nativeSlotDigest: string;
  mafSlotDigest: string;
  context?: ExecutionContext;
  decision?: ExecutionGateDecision;
  campaignGate?: CampaignGateDecision;
}): ProviderAuthorization => {
  const context = input.context ?? testExecutionContext;
  const authorization = issueProviderAuthorization({
    decision: input.decision ?? authenticDecision(input.identity, context),
    campaignGate: input.campaignGate ?? authorizedCampaignGate(),
    campaignId: input.campaignId,
    scheduleDigest: input.scheduleDigest,
    nativeSlotDigest: input.nativeSlotDigest,
    mafSlotDigest: input.mafSlotDigest,
    providerIdentity: input.identity,
    executionContext: context,
  });
  if (!authorization) {
    throw new Error("issueProviderAuthorization refused to mint a capability for this test");
  }
  return authorization;
};
