import { describe, expect, it } from "vitest";
import { deriveRiskVector, type RiskEvidenceInput } from "../src/domain/risk";

const evidence = (overrides: Partial<RiskEvidenceInput> = {}): RiskEvidenceInput => ({
  files: [],
  moduleOwnership: {},
  packageOwnership: {},
  crossModuleEdgeCount: 0,
  ...overrides,
});

describe("deriveRiskVector", () => {
  it("returns every dimension, never a collapsed scalar", () => {
    const vector = deriveRiskVector(evidence());
    expect(Object.keys(vector).sort()).toEqual(
      [
        "ArchitectureSensitivity",
        "BlastRadius",
        "CodeCoupling",
        "DataConsistencyRisk",
        "DebtRisk",
        "NetworkBoundaryChanges",
        "OperationalSensitivity",
        "PerformanceSensitivity",
        "ReasoningDifficulty",
        "SecuritySensitivity",
      ].sort(),
    );
  });

  it("stays LOW everywhere for an empty, evidence-free change", () => {
    const vector = deriveRiskVector(evidence());
    for (const value of Object.values(vector)) expect(value.level).toBe("LOW");
  });

  it("honestly marks dimensions with no deterministic source as insufficient evidence", () => {
    const vector = deriveRiskVector(evidence());
    expect(vector.ReasoningDifficulty.provenance).toBe("INSUFFICIENT_EVIDENCE");
    // No diff yet, so no declared-debt delta can be measured — pre-execution stays honest.
    expect(vector.DebtRisk.provenance).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("derives DebtRisk deterministically from the diff's declared-debt markers (M7A)", () => {
    const flat = deriveRiskVector(evidence({ debtMarkers: { added: 1, removed: 1 } }));
    expect(flat.DebtRisk.level).toBe("LOW");
    expect(flat.DebtRisk.provenance).toBe("DETERMINISTIC");
    const medium = deriveRiskVector(evidence({ debtMarkers: { added: 2, removed: 0 } }));
    expect(medium.DebtRisk.level).toBe("MEDIUM");
    expect(medium.DebtRisk.evidence[0]).toContain("net 2");
    const high = deriveRiskVector(evidence({ debtMarkers: { added: 5, removed: 0 } }));
    expect(high.DebtRisk.level).toBe("HIGH");
  });

  it("flags security sensitivity deterministically from an auth-shaped path", () => {
    const vector = deriveRiskVector(evidence({ files: ["src/application/auth-service.ts"] }));
    expect(vector.SecuritySensitivity.level).not.toBe("LOW");
    expect(vector.SecuritySensitivity.provenance).toBe("DETERMINISTIC");
    expect(vector.SecuritySensitivity.evidence[0]).toContain("auth-service.ts");
  });

  it("flags data-consistency risk from a migration path", () => {
    const vector = deriveRiskVector(evidence({ files: ["migrations/006_add_column.sql"] }));
    expect(vector.DataConsistencyRisk.level).not.toBe("LOW");
    expect(vector.DataConsistencyRisk.provenance).toBe("DETERMINISTIC");
    expect(vector.PerformanceSensitivity.level).not.toBe("LOW");
  });

  it("derives diff-backed performance sensitivity from DB and network operations", () => {
    const diffPatch = [
      "--- a/src/server/client.ts",
      "+++ b/src/server/client.ts",
      "@@ -1,1 +1,3 @@",
      "+await fetch('https://example.invalid/data');",
      "+await database.query('SELECT * FROM data');",
    ].join("\n");
    const vector = deriveRiskVector(evidence({ files: ["src/server/client.ts"], diffPatch }));
    expect(vector.PerformanceSensitivity.level).toBe("MEDIUM");
    expect(vector.PerformanceSensitivity.provenance).toBe("DETERMINISTIC");
    expect(vector.PerformanceSensitivity.evidence.join(" ")).toContain("NETWORK_CALL");
  });

  it("raises CodeCoupling and BlastRadius with the number of distinct modules/packages touched", () => {
    const vector = deriveRiskVector(
      evidence({
        files: ["apps/web/a.ts", "apps/api/b.ts", "packages/shared/c.ts"],
        moduleOwnership: {
          "apps/web/a.ts": "apps/web",
          "apps/api/b.ts": "apps/api",
          "packages/shared/c.ts": "packages/shared",
        },
        packageOwnership: {
          "apps/web/a.ts": "apps/web",
          "apps/api/b.ts": "apps/api",
          "packages/shared/c.ts": "packages/shared",
        },
      }),
    );
    expect(vector.CodeCoupling.level).not.toBe("LOW");
    expect(vector.BlastRadius.level).not.toBe("LOW");
  });

  it("raises ArchitectureSensitivity with resolved cross-module edges", () => {
    const vector = deriveRiskVector(evidence({ crossModuleEdgeCount: 6 }));
    expect(vector.ArchitectureSensitivity.level).toBe("HIGH");
    expect(vector.ArchitectureSensitivity.provenance).toBe("DETERMINISTIC");
  });

  it("marks path-pattern-derived dimensions HEURISTIC when nothing matched, not falsely confident", () => {
    const vector = deriveRiskVector(evidence({ files: ["README.md"] }));
    expect(vector.SecuritySensitivity.provenance).toBe("HEURISTIC");
    expect(vector.NetworkBoundaryChanges.provenance).toBe("HEURISTIC");
  });

  it("marks CodeCoupling/BlastRadius/ArchitectureSensitivity INSUFFICIENT_EVIDENCE when no touched file has ownership coverage", () => {
    // migrations/*.sql, Dockerfiles, and CI workflow files are never parsed source files, so M2's
    // moduleOwnership/packageOwnership maps have zero entries for them — a confident DETERMINISTIC
    // "LOW" here would misrepresent having no visibility as having checked and found nothing.
    const vector = deriveRiskVector(evidence({ files: ["migrations/006_add_column.sql"] }));
    expect(vector.CodeCoupling.provenance).toBe("INSUFFICIENT_EVIDENCE");
    expect(vector.BlastRadius.provenance).toBe("INSUFFICIENT_EVIDENCE");
    expect(vector.ArchitectureSensitivity.provenance).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("degrades CodeCoupling/BlastRadius to HEURISTIC (not DETERMINISTIC) when only some touched files have ownership coverage", () => {
    const vector = deriveRiskVector(
      evidence({
        files: ["src/domain/permissions.ts", "migrations/006_add_column.sql"],
        moduleOwnership: { "src/domain/permissions.ts": "src/domain" },
        packageOwnership: { "src/domain/permissions.ts": "src/domain" },
      }),
    );
    expect(vector.CodeCoupling.provenance).toBe("HEURISTIC");
    expect(vector.BlastRadius.provenance).toBe("HEURISTIC");
  });
});
