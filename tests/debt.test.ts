import { describe, expect, it } from "vitest";

import { DEBT_FAIL_THRESHOLD, deriveDebtDelta } from "../src/domain/debt";

const patchFor = (file: string, added: string[], removed: string[] = []): string =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 1,1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("deriveDebtDelta (M7A)", () => {
  it("passes when the diff adds no debt markers", () => {
    const result = deriveDebtDelta(patchFor("src/domain/widget.ts", ["export const x = 1;"]));
    expect(result.state).toBe("PASS");
    expect(result.addedMarkers).toBe(0);
    expect(result.removedMarkers).toBe(0);
  });

  it("warns when the diff adds declared-debt markers", () => {
    const result = deriveDebtDelta(
      patchFor("src/domain/widget.ts", ["// TODO: fix this later", "// FIXME: broken"]),
    );
    expect(result.state).toBe("WARN");
    expect(result.addedMarkers).toBe(2);
    expect(result.removedMarkers).toBe(0);
  });

  it("fails when the net marker increase meets the rewrite-deferral threshold", () => {
    const markers = Array.from({ length: DEBT_FAIL_THRESHOLD }, (_, i) => `// TODO: item ${i}`);
    const result = deriveDebtDelta(patchFor("src/domain/widget.ts", markers));
    expect(result.state).toBe("FAIL");
  });

  it("counts debt paydown: removed markers offset added ones", () => {
    const result = deriveDebtDelta(
      patchFor(
        "src/domain/widget.ts",
        ["// TODO: new one"],
        ["// TODO: old debt", "// FIXME: older debt", "// HACK: oldest"],
      ),
    );
    expect(result.state).toBe("PASS");
    expect(result.addedMarkers).toBe(1);
    expect(result.removedMarkers).toBe(3);
    expect(result.evidence[0]).toContain("net -2");
  });

  it("ignores markers in non-source files", () => {
    const result = deriveDebtDelta(patchFor("docs/plan.md", ["TODO: everything"]));
    expect(result.state).toBe("PASS");
    expect(result.addedMarkers).toBe(0);
  });

  it("requires word boundaries — TODOS or autodoc do not count", () => {
    const result = deriveDebtDelta(patchFor("src/domain/widget.ts", ["const TODOS = [];"]));
    expect(result.addedMarkers).toBe(0);
    expect(result.state).toBe("PASS");
  });

  it("passes on an empty patch (nothing changed)", () => {
    const result = deriveDebtDelta("");
    expect(result.state).toBe("PASS");
    expect(result.evidence[0]).toContain("no source files changed");
  });

  it("counts a deleted file's markers as removed debt", () => {
    const patch = [
      "--- a/src/domain/legacy.ts",
      "+++ /dev/null",
      "@@ -1,2 0,0 @@",
      "-// TODO: first legacy marker",
      "-// TODO: second legacy marker",
      "--- a/src/domain/other.ts",
      "+++ b/src/domain/other.ts",
      "@@ -1,0 1,1 @@",
      "+// TODO: new marker",
    ].join("\n");
    const result = deriveDebtDelta(patch);
    expect(result.addedMarkers).toBe(1);
    expect(result.removedMarkers).toBe(2);
    expect(result.state).toBe("PASS");
  });
});
