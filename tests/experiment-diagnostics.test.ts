import { describe, expect, it } from "vitest";
import {
  classifyModelProvenance,
  modelProvenanceAcceptableForPreflight,
  summarizeStderr,
  MAX_STDERR_TAIL_CHARS,
} from "../evaluation/experiments/real/lib/diagnostics";

describe("model provenance (placeholder identity must never be RESOLVED)", () => {
  it("rejects the exact identity the first billed preflight recorded as RESOLVED", () => {
    const provenance = classifyModelProvenance({
      requestedModel: "claude-sonnet-5",
      reportedModel: "<synthetic>",
    });
    expect(provenance.resolvedModelStatus).toBe("PLACEHOLDER_OR_SYNTHETIC");
    expect(provenance.resolvedModel).toBeNull();
    // The raw string is preserved for audit rather than discarded.
    expect(provenance.rawReportedModel).toBe("<synthetic>");
    expect(modelProvenanceAcceptableForPreflight(provenance)).toBe(false);
  });

  it("rejects placeholder shapes generally, not just the one literal observed", () => {
    for (const placeholder of [
      "<unknown>",
      "[redacted]",
      "mock-model",
      "fake",
      "test",
      "unknown",
      "none",
      "a synthetic model",
      "placeholder-v1",
    ]) {
      const provenance = classifyModelProvenance({
        requestedModel: "claude-sonnet-5",
        reportedModel: placeholder,
      });
      expect(
        provenance.resolvedModelStatus,
        `${placeholder} should not be treated as a real model identity`,
      ).toBe("PLACEHOLDER_OR_SYNTHETIC");
    }
  });

  it("accepts a concrete dated snapshot identifier as RESOLVED", () => {
    const provenance = classifyModelProvenance({
      requestedModel: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5-20250929",
    });
    expect(provenance.resolvedModelStatus).toBe("RESOLVED");
    expect(provenance.resolvedModel).toBe("claude-sonnet-5-20250929");
    expect(modelProvenanceAcceptableForPreflight(provenance)).toBe(true);
  });

  it("reports ALIAS_ONLY when the provider only echoes the requested alias", () => {
    const provenance = classifyModelProvenance({
      requestedModel: "claude-sonnet-5",
      reportedModel: "claude-sonnet-5",
    });
    expect(provenance.resolvedModelStatus).toBe("ALIAS_ONLY");
    // The alias is known; no underlying immutable version is invented.
    expect(provenance.resolvedModel).toBe("claude-sonnet-5");
    expect(modelProvenanceAcceptableForPreflight(provenance)).toBe(true);
  });

  it("reports NOT_REPORTED when the provider said nothing at all", () => {
    const provenance = classifyModelProvenance({
      requestedModel: "claude-sonnet-5",
      reportedModel: null,
    });
    expect(provenance.resolvedModelStatus).toBe("NOT_REPORTED");
    expect(provenance.resolvedModel).toBeNull();
    expect(modelProvenanceAcceptableForPreflight(provenance)).toBe(false);
  });
});

describe("stderr diagnostics (bounded, redacted, never lost)", () => {
  it("records that nothing was observed rather than fabricating an empty string", () => {
    const diagnostics = summarizeStderr([]);
    expect(diagnostics.observed).toBe(false);
    expect(diagnostics.summary).toBeNull();
    expect(diagnostics.tail).toBeNull();
  });

  it("captures a summary and tail for a real failure message", () => {
    const diagnostics = summarizeStderr([
      "Authentication failed: not logged in\n",
      "detail line\n",
    ]);
    expect(diagnostics.observed).toBe(true);
    expect(diagnostics.summary).toBe("Authentication failed: not logged in");
    expect(diagnostics.tail).toContain("detail line");
  });

  it("bounds a large stream and reports that it was truncated", () => {
    const diagnostics = summarizeStderr(["x".repeat(MAX_STDERR_TAIL_CHARS * 3)]);
    expect(diagnostics.truncated).toBe(true);
    expect(diagnostics.totalChars).toBe(MAX_STDERR_TAIL_CHARS * 3);
    expect((diagnostics.tail ?? "").length).toBeLessThanOrEqual(MAX_STDERR_TAIL_CHARS);
  });

  it("redacts credential-shaped text before it can reach durable provenance", () => {
    const diagnostics = summarizeStderr([
      "failed with key sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM\n",
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(
      "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLLMMMM",
    );
  });
});
