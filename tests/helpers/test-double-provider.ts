// Shared helper for tests that need an APPROVED test-double provider identity.
//
// There is deliberately no shortcut here. This calls the same `approveTestDoubleProvider` the
// production command calls, against the same on-disk fake CLI, and fails loudly if approval is
// refused. A test helper that fabricated an identity would reintroduce exactly the hole Runner v2
// closes -- the identity brand is module-private precisely so that "just make one for the test" is
// not available to anyone, including this file.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveTestDoubleProvider,
  detectExecutionContext,
  type ProviderIdentity,
} from "../../evaluation/experiments/scoring/lib/provider-identity";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The repository's canonical fake Claude CLI, carrying the test-double marker. */
export const FAKE_CLAUDE_CLI = path.resolve(here, "..", "fixtures", "fake-claude-cli.mjs");

/**
 * Approves a test-double provider, throwing with the refusal reason if it cannot be approved.
 *
 * Defaults to the repository's fake CLI, which lives under tests/fixtures/ and is therefore inside a
 * declared test-controlled fixture root.
 */
export const approvedTestDouble = async (
  executablePath: string = FAKE_CLAUDE_CLI,
): Promise<ProviderIdentity> => {
  const outcome = await approveTestDoubleProvider({
    executablePath,
    context: detectExecutionContext(),
  });
  if (!outcome.approved) {
    throw new Error(
      `test-double provider ${executablePath} was NOT approved (${outcome.reason}): ${outcome.detail}`,
    );
  }
  return outcome.identity;
};
