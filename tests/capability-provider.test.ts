import { describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "../src/application/capability-registry";
import type { CapabilityId } from "../src/domain/assurance-obligation";
import { validateCapabilityResultBinding } from "../src/domain/capability/binding";
import { foldCapabilityResult } from "../src/domain/capability/fold";
import type {
  CapabilityInput,
  CapabilityProvider,
  CapabilityResult,
  ProviderProvenance,
} from "../src/domain/capability/provider";

const capabilityId: CapabilityId = "SECURITY.SEMANTIC_FLOW_SCAN";

const provenance = (overrides: Partial<ProviderProvenance> = {}): ProviderProvenance => ({
  capabilityId,
  providerName: "fixture-provider",
  providerVersion: "1.0.0",
  invokedAt: "2026-08-24T00:00:00.000Z",
  durationMs: 12,
  candidateId: "candidate-1",
  diffDigest: "sha256:candidate-1",
  baseRevision: "revision-1",
  ...overrides,
});

const result = (overrides: Partial<CapabilityResult> = {}): CapabilityResult => ({
  provenance: provenance(),
  execution: { outcome: "COMPLETED", exitCode: 0 },
  findings: [],
  coverage: { TS_JS: "FULL" },
  negativeCoverage: { TS_JS: "FULL" },
  analyzedFiles: ["src/example.ts"],
  ...overrides,
});

const input = (overrides: Partial<CapabilityInput> = {}): CapabilityInput => ({
  capabilityId,
  sandbox: {
    id: "sandbox-1",
    path: "/workspace/candidate-1",
    repositoryPath: "/repository",
    baseRevision: "revision-1",
    revision: "main",
  },
  diff: { patch: "+candidate change", changedFiles: ["src/example.ts"] },
  candidateId: "candidate-1",
  diffDigest: "sha256:candidate-1",
  ...overrides,
});

const bound = (value: CapabilityResult = result()) => {
  const validation = validateCapabilityResultBinding(value, {
    input: input(),
    providerName: "fixture-provider",
    providerVersion: "1.0.0",
  });
  if (!validation.valid) throw new Error(validation.reasons.join("; "));
  return validation.boundResult;
};

const fakeProvider = (name: string, probe: CapabilityProvider["probe"]): CapabilityProvider => ({
  capabilityId,
  name,
  probe,
  analyze: async () => result({ provenance: provenance({ providerName: name }) }),
});

describe("capability provider foundation", () => {
  it("maps an unavailable provider to NOT_CHECKED, never PASS", () => {
    const folded = foldCapabilityResult(
      bound(result({ execution: { outcome: "UNAVAILABLE", detail: "binary absent" } })),
      ["TS_JS"],
    );

    expect(folded.status).toBe("NOT_CHECKED");
    expect(folded.justification).toContain("unavailable");
  });

  it("does not turn scanner silence without negative coverage into absence", () => {
    const folded = foldCapabilityResult(
      bound(result({ negativeCoverage: { TS_JS: "UNSUPPORTED" } })),
      ["TS_JS"],
    );

    expect(folded).toMatchObject({ status: "UNSUPPORTED", coverage: "UNSUPPORTED" });
  });

  it("rejects unknown runtime coverage values before they can fall through to PASS", () => {
    const validation = validateCapabilityResultBinding(
      result({
        coverage: { TS_JS: "garbage" } as unknown as CapabilityResult["coverage"],
        negativeCoverage: {
          TS_JS: "garbage",
        } as unknown as CapabilityResult["negativeCoverage"],
      }),
      {
        input: input(),
        providerName: "fixture-provider",
        providerVersion: "1.0.0",
      },
    );

    expect(validation.valid).toBe(false);
  });

  it("clamps provider-reported negative coverage to the canonical capability ceiling", () => {
    expect(foldCapabilityResult(bound(), ["TS_JS"])).toMatchObject({
      status: "UNKNOWN",
      coverage: "PARTIAL",
    });
    expect(foldCapabilityResult(bound(), ["TS_JS", "PYTHON"])).toMatchObject({
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
    });
    expect(
      foldCapabilityResult(bound(result({ coverage: { TS_JS: "PARTIAL" } })), ["TS_JS"]),
    ).toMatchObject({ status: "UNKNOWN", coverage: "PARTIAL" });
  });

  it("requires provenance and normalized positive findings before applying evidence", () => {
    const unbound = validateCapabilityResultBinding(
      result({ provenance: provenance({ diffDigest: "" }) }),
      {
        input: input(),
        providerName: "fixture-provider",
        providerVersion: "1.0.0",
      },
    );
    expect(unbound.valid).toBe(false);

    const malformedFinding = validateCapabilityResultBinding(
      result({
        findings: [
          {
            target: "SECURITY.SENSITIVE_INPUT_FLOW",
            claim: "NEGATIVE_ABSENCE",
            strength: "STRUCTURAL",
            file: "src/example.ts",
            ruleId: "fixture-rule",
            message: "not a positive finding",
            severity: "HIGH",
          },
        ],
      }),
      {
        input: input(),
        providerName: "fixture-provider",
        providerVersion: "1.0.0",
      },
    );
    expect(malformedFinding.valid).toBe(false);
  });

  it("folds normalized findings by severity without requiring complete negative coverage", () => {
    const finding = {
      target: "SECURITY.SENSITIVE_INPUT_FLOW" as const,
      claim: "POSITIVE_FINDING" as const,
      strength: "STRUCTURAL" as const,
      file: "src/example.ts",
      ruleId: "fixture-rule",
      message: "candidate exposes sensitive input",
    };
    expect(
      foldCapabilityResult(
        bound(
          result({
            findings: [{ ...finding, severity: "CRITICAL" }],
            coverage: { TS_JS: "PARTIAL" },
            negativeCoverage: { TS_JS: "UNSUPPORTED" },
          }),
        ),
        ["TS_JS"],
      ).status,
    ).toBe("FAIL");
    expect(
      foldCapabilityResult(bound(result({ findings: [{ ...finding, severity: "MEDIUM" }] })), [
        "TS_JS",
      ]).status,
    ).toBe("WARN");
  });

  it("treats malformed output and timeouts as bounded non-results", () => {
    const malformed = foldCapabilityResult(
      bound(result({ execution: { outcome: "MALFORMED_OUTPUT", detail: "invalid JSON" } })),
      ["TS_JS"],
    );
    const timeout = foldCapabilityResult(
      bound(result({ execution: { outcome: "TIMED_OUT", timeoutMs: 1_000 } })),
      ["TS_JS"],
    );

    expect(malformed.status).toBe("NOT_CHECKED");
    expect(timeout.status).toBe("NOT_CHECKED");
    expect(timeout.justification).toContain("1000ms");
  });

  it("rejects an absence claim when no analyzed file proves provider scope", () => {
    expect(foldCapabilityResult(bound(result({ analyzedFiles: [] })), ["TS_JS"])).toMatchObject({
      status: "UNSUPPORTED",
      coverage: "UNSUPPORTED",
    });
  });

  it("keeps provider versions distinguishable in otherwise identical evidence", () => {
    const before = result({ provenance: provenance({ providerVersion: "1.0.0" }) });
    const after = result({ provenance: provenance({ providerVersion: "2.0.0" }) });

    expect(before.provenance).not.toEqual(after.provenance);
    expect(before.provenance.providerVersion).toBe("1.0.0");
    expect(after.provenance.providerVersion).toBe("2.0.0");
  });

  it("preserves base semantics when no optional provider is registered", async () => {
    const registry = new CapabilityRegistry();
    await expect(registry.resolve(capabilityId)).resolves.toEqual([]);
  });

  it("resolves available providers in registration order and caches safe probes", async () => {
    const firstProbe = vi.fn(async () => ({
      available: true,
      version: "1.0.0",
      detail: "available",
    }));
    const throwingProbe = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const secondProbe = vi.fn(async () => ({
      available: true,
      version: "2.0.0",
      detail: "available",
    }));
    const first = fakeProvider("first", firstProbe);
    const unavailable = fakeProvider("unavailable", throwingProbe);
    const second = fakeProvider("second", secondProbe);
    const registry = new CapabilityRegistry();
    registry.register(first);
    registry.register(unavailable);
    registry.register(second);

    await expect(registry.resolve(capabilityId)).resolves.toEqual([first, second]);
    await expect(registry.resolve(capabilityId)).resolves.toEqual([first, second]);
    expect(firstProbe).toHaveBeenCalledTimes(1);
    expect(throwingProbe).toHaveBeenCalledTimes(1);
    expect(secondProbe).toHaveBeenCalledTimes(1);
  });
});
