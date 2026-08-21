import { describe, expect, it } from "vitest";
import {
  ciConclusionLabel,
  failureClassificationLabel,
  healthDirectionTone,
  mergeEligibilityLabel,
  productionImpactLabel,
  qualityStateLabel,
  qualityStateTone,
  riskLevelLabel,
  riskProvenanceNote,
  trustStateLabel,
  trustStateTone,
} from "../src/web/status";

describe("engine-state to user-meaning translation", () => {
  it("never lets NOT_CHECKED or NOT_REQUIRED read as PASS", () => {
    expect(qualityStateLabel("NOT_CHECKED")).not.toBe(qualityStateLabel("PASS"));
    expect(qualityStateLabel("NOT_REQUIRED")).not.toBe(qualityStateLabel("PASS"));
    expect(qualityStateTone("NOT_CHECKED")).not.toBe("success");
    expect(qualityStateTone("NOT_REQUIRED")).not.toBe("success");
    expect(qualityStateTone("UNKNOWN")).not.toBe("success");
    expect(qualityStateTone("PASS")).toBe("success");
    expect(qualityStateTone("FAIL")).toBe("danger");
  });

  it("defaults unknown/missing quality state to chưa kiểm tra rather than guessing", () => {
    expect(qualityStateLabel(undefined)).toBe("Chưa kiểm tra");
    expect(qualityStateLabel("SOMETHING_NEW")).toBe("Chưa kiểm tra");
  });

  it("distinguishes the full trust ladder, including a pending-review QUALITY_VERIFIED", () => {
    expect(trustStateLabel("MERGE_ELIGIBLE")).toContain("Đủ điều kiện");
    expect(trustStateLabel("CORRECTNESS_VERIFIED")).toContain("chưa đủ");
    expect(trustStateLabel("QUALITY_VERIFIED", true)).toContain("chờ đánh giá độc lập");
    expect(trustStateLabel("QUALITY_VERIFIED", false)).not.toContain("chờ đánh giá độc lập");
    expect(trustStateTone("MERGE_ELIGIBLE")).toBe("success");
    expect(trustStateTone("CORRECTNESS_VERIFIED")).not.toBe("success");
  });

  it("flags insufficient risk evidence instead of reporting a quiet LOW", () => {
    expect(riskProvenanceNote("INSUFFICIENT_EVIDENCE")).toBeDefined();
    expect(riskProvenanceNote("DETERMINISTIC")).toBeUndefined();
    expect(riskLevelLabel("HIGH")).toBe("Cao");
  });

  it("translates failure classification and always has an honest fallback", () => {
    expect(failureClassificationLabel("BUDGET_EXHAUSTED")).toContain("hết ngân sách");
    expect(failureClassificationLabel(undefined)).toBe("Chưa xác định được nguyên nhân");
    expect(failureClassificationLabel("UNKNOWN_FAILURE")).toBe("Chưa xác định được nguyên nhân");
  });

  it("keeps merge authority language honest — MAF never merges", () => {
    expect(mergeEligibilityLabel("ELIGIBLE")).toContain("phê duyệt bên ngoài");
    expect(ciConclusionLabel("NOT_CHECKED")).not.toBe(ciConclusionLabel("PASS"));
  });

  it("never tones an unclassified health trend or missing production evidence as success", () => {
    expect(healthDirectionTone("UNKNOWN")).not.toBe("success");
    expect(healthDirectionTone("FLAT")).not.toBe("success");
    expect(healthDirectionTone("DEGRADING")).toBe("danger");
    expect(productionImpactLabel(undefined)).toBe(productionImpactLabel("UNKNOWN"));
    expect(productionImpactLabel("UNKNOWN")).not.toBe(productionImpactLabel("STABLE"));
  });
});
