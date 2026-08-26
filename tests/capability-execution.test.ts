import { describe, expect, it, vi } from "vitest";
import {
  executeCapability,
  executeRegisteredCapabilities,
  projectCapabilityConcerns,
  type CapabilityExecutionObserver,
} from "../src/application/capability-execution";
import { CapabilityRegistry } from "../src/application/capability-registry";
import type { CapabilityId } from "../src/domain/assurance-obligation";
import { validateCapabilityResultBinding } from "../src/domain/capability/binding";
import { foldCapabilityResult } from "../src/domain/capability/fold";
import type {
  CapabilityInput,
  CapabilityProvider,
  CapabilityResult,
} from "../src/domain/capability/provider";

const capabilityId: CapabilityId = "SECURITY.SEMANTIC_FLOW_SCAN";

const capabilityInput = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  capabilityId,
  sandbox: {
    id: "sandbox-1",
    path: "/work/candidate",
    repositoryPath: "/work/repository",
    baseRevision: "revision-r1",
    revision: "main",
  },
  diff: {
    patch: "+const secret = readSecret();",
    changedFiles: ["src/secret.ts"],
  },
  candidateId: "candidate-a",
  diffDigest: "sha256:candidate-a",
  ...overrides,
});

const capabilityResult = (
  active: CapabilityInput = capabilityInput(),
  overrides: Partial<CapabilityResult> = {},
): CapabilityResult => ({
  provenance: {
    capabilityId: active.capabilityId,
    providerName: "fixture-provider",
    providerVersion: "1.0.0",
    invokedAt: "2026-08-24T00:00:00.000Z",
    durationMs: 10,
    candidateId: active.candidateId,
    diffDigest: active.diffDigest,
    baseRevision: active.sandbox.baseRevision,
  },
  execution: { outcome: "COMPLETED", exitCode: 0 },
  findings: [],
  coverage: { TS_JS: "FULL" },
  negativeCoverage: { TS_JS: "FULL" },
  analyzedFiles: ["src/secret.ts"],
  ...overrides,
});

const provider = (
  analyze: CapabilityProvider["analyze"],
  probe: CapabilityProvider["probe"] = async () => ({
    available: true,
    version: "1.0.0",
    detail: "fixture available",
  }),
): CapabilityProvider => ({
  capabilityId,
  name: "fixture-provider",
  probe,
  analyze,
});

const executeOne = async (
  active: CapabilityInput,
  fixtureProvider: CapabilityProvider,
  options: {
    observer?: CapabilityExecutionObserver;
    revalidate?: () => Promise<{ diffDigest: string; baseRevision: string }>;
  } = {},
) => {
  const registry = new CapabilityRegistry();
  registry.register(fixtureProvider);
  const evidence = await executeCapability({
    registry,
    input: active,
    candidateLanguageClasses: ["TS_JS"],
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.revalidate ? { revalidate: options.revalidate } : {}),
  });
  expect(evidence).toHaveLength(1);
  const first = evidence[0];
  if (!first) throw new Error("fixture provider produced no execution evidence");
  return first;
};

describe("active capability invocation binding", () => {
  it.each([
    {
      name: "candidate A result on candidate B",
      active: capabilityInput({ candidateId: "candidate-b", diffDigest: "sha256:candidate-b" }),
      expectedReason: "candidate id",
    },
    {
      name: "same candidate id with the wrong digest",
      active: capabilityInput({ diffDigest: "sha256:changed" }),
      expectedReason: "candidate digest",
    },
    {
      name: "the right digest at a different base revision",
      active: capabilityInput({
        sandbox: { ...capabilityInput().sandbox, baseRevision: "revision-r2" },
      }),
      expectedReason: "base revision",
    },
    {
      name: "a result for another requested capability",
      active: capabilityInput({ capabilityId: "SECURITY.CREDENTIAL_LITERAL_SCAN" }),
      expectedReason: "requested capability",
    },
  ])("rejects $name", ({ active, expectedReason }) => {
    const validation = validateCapabilityResultBinding(capabilityResult(), {
      input: active,
      providerName: "fixture-provider",
      providerVersion: "1.0.0",
    });

    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reasons.join(" ")).toContain(expectedReason);
  });

  it("rejects provider identity and probed-version mismatches", () => {
    const active = capabilityInput();
    const identity = validateCapabilityResultBinding(capabilityResult(active), {
      input: active,
      providerName: "another-provider",
      providerVersion: "1.0.0",
    });
    const version = validateCapabilityResultBinding(capabilityResult(active), {
      input: active,
      providerName: "fixture-provider",
      providerVersion: "2.0.0",
    });

    expect(identity.valid).toBe(false);
    expect(version.valid).toBe(false);
  });

  it("refreshes provider version provenance for every canonical invocation", async () => {
    const active = capabilityInput();
    const registry = new CapabilityRegistry();
    let installedVersion = "1.0.0";
    const probe = vi.fn(async () => ({
      available: true,
      version: installedVersion,
      detail: "fixture available",
    }));
    registry.register(
      provider(async (input) => {
        const result = capabilityResult(input);
        return {
          ...result,
          provenance: {
            ...result.provenance,
            providerVersion: installedVersion,
          },
        };
      }, probe),
    );

    const execute = async () => {
      const evidence = await executeCapability({
        registry,
        input: active,
        candidateLanguageClasses: ["TS_JS"],
      });
      expect(evidence).toHaveLength(1);
      return evidence[0];
    };

    await expect(execute()).resolves.toMatchObject({
      providerVersion: "1.0.0",
      status: "UNKNOWN",
      coverage: "PARTIAL",
    });
    installedVersion = "1.0.1";
    await expect(execute()).resolves.toMatchObject({
      providerVersion: "1.0.1",
      status: "UNKNOWN",
      coverage: "PARTIAL",
    });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenNthCalledWith(1, { fresh: true });
    expect(probe).toHaveBeenNthCalledWith(2, { fresh: true });
  });

  it("rejects empty active binding fields before a result can be folded", () => {
    const empty = capabilityInput({ candidateId: "", diffDigest: "" });
    const validation = validateCapabilityResultBinding(capabilityResult(empty), {
      input: empty,
      providerName: "fixture-provider",
      providerVersion: "1.0.0",
    });

    expect(validation.valid).toBe(false);
    if (!validation.valid) expect(validation.reasons.join(" ")).toMatch(/active candidate/u);
  });

  it("does not let a stale empty result gain absence authority", async () => {
    const candidateA = capabilityInput();
    const candidateB = capabilityInput({
      candidateId: "candidate-b",
      diffDigest: "sha256:candidate-b",
    });
    const evidence = await executeOne(
      candidateB,
      provider(async () => capabilityResult(candidateA)),
    );

    expect(evidence).toMatchObject({
      binding: "REJECTED",
      outcome: "BINDING_REJECTED",
      status: "NOT_CHECKED",
      findingCount: 0,
      coverage: "UNSUPPORTED",
    });
  });

  it("isolates the active binding from provider mutations of its input", async () => {
    const active = capabilityInput();
    const evidence = await executeOne(
      active,
      provider(async (providerInput) => {
        providerInput.candidateId = "provider-repainted-candidate";
        providerInput.diffDigest = "sha256:provider-repainted";
        providerInput.sandbox.baseRevision = "provider-repainted-revision";
        return capabilityResult(providerInput);
      }),
    );

    expect(evidence).toMatchObject({
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      status: "NOT_CHECKED",
      candidateId: "candidate-a",
      diffDigest: "sha256:candidate-a",
      baseRevision: "revision-r1",
    });
    expect(active).toMatchObject({
      candidateId: "candidate-a",
      diffDigest: "sha256:candidate-a",
      sandbox: { baseRevision: "revision-r1" },
    });
  });

  it("binds to the provider identity selected at registration, not a later mutable getter", async () => {
    const active = capabilityInput();
    let currentName = "fixture-provider";
    const mutableIdentityProvider: CapabilityProvider = {
      capabilityId,
      get name() {
        return currentName;
      },
      probe: async () => ({ available: true, version: "1.0.0", detail: "available" }),
      analyze: async (providerInput) => {
        currentName = "provider-repainted-name";
        const baseline = capabilityResult(providerInput);
        return {
          ...baseline,
          provenance: { ...baseline.provenance, providerName: currentName },
        };
      },
    };

    const evidence = await executeOne(active, mutableIdentityProvider);

    expect(evidence).toMatchObject({
      providerName: "fixture-provider",
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      status: "NOT_CHECKED",
    });
  });

  it("keeps the fold invariant under representation and ordering changes", () => {
    const active = capabilityInput();
    const forward = capabilityResult(active, {
      coverage: { TS_JS: "FULL", PYTHON: "FULL" },
      negativeCoverage: { TS_JS: "FULL", PYTHON: "FULL" },
      analyzedFiles: ["src/a.ts", "src/b.py"],
    });
    const reversed = capabilityResult(active, {
      coverage: { PYTHON: "FULL", TS_JS: "FULL" },
      negativeCoverage: { PYTHON: "FULL", TS_JS: "FULL" },
      analyzedFiles: ["src/b.py", "src/a.ts"],
    });
    const bind = (result: CapabilityResult) =>
      validateCapabilityResultBinding(result, {
        input: active,
        providerName: "fixture-provider",
        providerVersion: "1.0.0",
      });
    const first = bind(forward);
    const second = bind(reversed);
    expect(first.valid).toBe(true);
    expect(second.valid).toBe(true);
    if (!first.valid || !second.valid) throw new Error("fixtures did not bind");

    expect(foldCapabilityResult(first.boundResult, ["TS_JS", "PYTHON"])).toEqual(
      foldCapabilityResult(second.boundResult, ["PYTHON", "TS_JS"]),
    );
  });
});

describe("canonical capability execution", () => {
  it("preserves empty-registry identity", async () => {
    await expect(
      executeRegisteredCapabilities({
        registry: new CapabilityRegistry(),
        input: capabilityInput(),
      }),
    ).resolves.toEqual([]);
  });

  it("turns a throwing probe into unavailable evidence rather than zero findings", async () => {
    const analyze = vi.fn(async () => capabilityResult());
    const evidence = await executeOne(
      capabilityInput(),
      provider(analyze, async () => {
        throw new Error("probe secret must not escape");
      }),
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: "UNAVAILABLE",
      status: "NOT_CHECKED",
      coverage: "UNSUPPORTED",
      findingCount: 0,
    });
    expect(evidence.justification).not.toContain("probe secret");
  });

  it("rejects workspace drift after execution and before binding or folding", async () => {
    const active = capabilityInput();
    const evidence = await executeOne(
      active,
      provider(async () => capabilityResult(active)),
      {
        revalidate: async () => ({
          diffDigest: "sha256:mutated-after-scan",
          baseRevision: active.sandbox.baseRevision,
        }),
      },
    );

    expect(evidence).toMatchObject({
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      status: "NOT_CHECKED",
    });
  });

  it("folds normalized positive findings without granting the provider policy authority", async () => {
    const active = capabilityInput();
    const evidence = await executeOne(
      active,
      provider(async () =>
        capabilityResult(active, {
          findings: [
            {
              target: "SECURITY.SENSITIVE_INPUT_FLOW",
              claim: "POSITIVE_FINDING",
              strength: "STRUCTURAL",
              file: "src/secret.ts",
              line: 1,
              ruleId: "fixture-flow",
              message: "sensitive input reaches output",
              severity: "HIGH",
            },
          ],
          coverage: { TS_JS: "PARTIAL" },
          negativeCoverage: { TS_JS: "UNSUPPORTED" },
        }),
      ),
    );

    expect(evidence).toMatchObject({
      outcome: "COMPLETED",
      binding: "MATCHED",
      status: "FAIL",
      findingCount: 1,
      coverage: "PARTIAL",
    });
    expect(evidence).not.toHaveProperty("trustState");
    expect(evidence).not.toHaveProperty("executionMode");
  });

  it("keeps clean output unsupported when negative coverage is unsupported", async () => {
    const active = capabilityInput();
    const evidence = await executeOne(
      active,
      provider(async () =>
        capabilityResult(active, {
          negativeCoverage: { TS_JS: "UNSUPPORTED" },
        }),
      ),
    );

    expect(evidence).toMatchObject({ status: "UNSUPPORTED", coverage: "UNSUPPORTED" });
  });

  it("redacts bounded process detail before normalized evidence can be persisted", async () => {
    const active = capabilityInput();
    const token = "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE";
    const evidence = await executeOne(
      active,
      provider(async () =>
        capabilityResult(active, {
          execution: { outcome: "PROCESS_ERROR", exitCode: 2, detail: `failed with ${token}` },
        }),
      ),
    );

    expect(evidence).toMatchObject({ outcome: "PROCESS_ERROR", status: "NOT_CHECKED" });
    expect(evidence.justification).not.toContain(token);
  });

  it("treats a secret-shaped probe version as unverified and never invokes analysis", async () => {
    const analyze = vi.fn(async () => capabilityResult());
    const evidence = await executeOne(
      capabilityInput(),
      provider(analyze, async () => ({
        available: true,
        version: "ghp_AAAA1111BBBB2222CCCC3333DDDD4444EEEE",
        detail: "reported version",
      })),
    );

    expect(analyze).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      outcome: "UNAVAILABLE",
      failureCategory: "VERSION_UNVERIFIED",
      providerVersion: null,
    });
  });

  it.each([
    {
      label: "non-text finding path",
      finding: {
        target: "SECURITY.SENSITIVE_INPUT_FLOW",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: 42,
        ruleId: "fixture-flow",
        message: "finding",
        severity: "HIGH",
      },
    },
    {
      label: "oversized finding message",
      finding: {
        target: "SECURITY.SENSITIVE_INPUT_FLOW",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        file: "src/secret.ts",
        ruleId: "fixture-flow",
        message: "x".repeat(4_097),
        severity: "HIGH",
      },
    },
    {
      label: "finding without an exact analyzed file witness",
      finding: {
        target: "SECURITY.SENSITIVE_INPUT_FLOW",
        claim: "POSITIVE_FINDING",
        strength: "STRUCTURAL",
        ruleId: "fixture-flow",
        message: "finding",
        severity: "HIGH",
      },
    },
  ])("rejects $label before malformed evidence can reach projection", async ({ finding }) => {
    const active = capabilityInput();
    const malformed = capabilityResult(active, {
      findings: [finding] as unknown as CapabilityResult["findings"],
    });
    const evidence = await executeOne(
      active,
      provider(async () => malformed),
    );

    expect(evidence).toMatchObject({
      outcome: "BINDING_REJECTED",
      binding: "REJECTED",
      status: "NOT_CHECKED",
      findingCount: 0,
    });
    expect(() => projectCapabilityConcerns([evidence])).not.toThrow();
    expect(projectCapabilityConcerns([evidence])).toEqual({ concerns: [], concernEvidence: [] });
  });

  it("is fail-open when the optional observer throws", async () => {
    const active = capabilityInput();
    const observer: CapabilityExecutionObserver = {
      record: vi.fn(() => {
        throw new Error("collector unavailable");
      }),
    };
    const evidence = await executeOne(
      active,
      provider(async () => capabilityResult(active)),
      { observer },
    );

    expect(evidence).toMatchObject({ status: "UNKNOWN", coverage: "PARTIAL", telemetry: "FAILED" });
    expect(observer.record).toHaveBeenCalledTimes(1);
  });
});
