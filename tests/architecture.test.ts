import { describe, expect, it } from "vitest";

import { deriveArchitectureGovernance } from "../src/domain/architecture";
import { parseFilePatches } from "../src/domain/diff-parse";

const patchFor = (file: string, added: string[], removed: string[] = []): string =>
  [
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,1 1,1 @@",
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

describe("deriveArchitectureGovernance (M7B)", () => {
  it("fails when a domain file adds an import of an outer layer", () => {
    for (const specifier of [
      '"../application/run-service"',
      '"../infrastructure/local-worktree"',
      '"../../application/run-service"',
    ]) {
      const result = deriveArchitectureGovernance(
        patchFor("src/domain/widget.ts", [`import { X } from ${specifier};`]),
      );
      expect(result.state).toBe("FAIL");
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain("outside src/domain");
    }
  });

  it("passes for in-domain relative imports and package imports", () => {
    const result = deriveArchitectureGovernance(
      patchFor("src/domain/widget.ts", [
        'import type { Foo } from "./types";',
        'import { bar } from "../domain/risk";',
        'import path from "node:path";',
        'import { z } from "zod";',
      ]),
    );
    expect(result.state).toBe("PASS");
    expect(result.violations).toHaveLength(0);
    expect(result.evidence[0]).toContain("2 added import(s)");
  });

  it("does not constrain layers above domain — application may import infrastructure", () => {
    const result = deriveArchitectureGovernance(
      patchFor("src/application/widget.ts", ['import { X } from "../infrastructure/x";']),
    );
    expect(result.state).toBe("PASS");
  });

  it("ignores non-source files entirely", () => {
    const result = deriveArchitectureGovernance(
      patchFor("src/domain/notes.md", ['import x from "../application/y"']),
    );
    expect(result.state).toBe("PASS");
  });

  it("ignores removed lines — only added imports can introduce a violation", () => {
    const result = deriveArchitectureGovernance(
      patchFor("src/domain/widget.ts", [], ['import { X } from "../application/run-service";']),
    );
    expect(result.state).toBe("PASS");
  });

  it("fails on side-effect imports and require() of an outer layer — no from-clause bypass", () => {
    for (const line of [
      'import "../application/register-side-effects";',
      'await import("../infrastructure/local-worktree");',
      'const x = require("../application/run-service");',
    ]) {
      const result = deriveArchitectureGovernance(patchFor("src/domain/widget.ts", [line]));
      expect(result.state).toBe("FAIL");
      expect(result.violations).toHaveLength(1);
    }
  });

  it("does not fabricate a violation from a comment mentioning a path", () => {
    const result = deriveArchitectureGovernance(
      patchFor("src/domain/widget.ts", [
        '// moved here from "../application/run-service"',
        "/* see ../application/run-service for the old home */",
      ]),
    );
    expect(result.state).toBe("PASS");
    expect(result.evidence[0]).toContain("no imports");
  });
});

describe("parseFilePatches", () => {
  it("attributes added and removed lines to the right file across multi-file diffs", () => {
    const patch = [
      "--- a/src/domain/a.ts",
      "+++ b/src/domain/a.ts",
      "@@ -1,1 1,2 @@",
      " const keep = 1;",
      "+const added = 2;",
      "-const gone = 3;",
      "--- a/src/domain/b.ts",
      "+++ b/src/domain/b.ts",
      "@@ -1,1 1,1 @@",
      "+const only = 4;",
    ].join("\n");
    const files = parseFilePatches(patch);
    expect(files.map((entry) => entry.file)).toEqual(["src/domain/a.ts", "src/domain/b.ts"]);
    expect(files[0]?.addedLines).toEqual(["const added = 2;"]);
    expect(files[0]?.removedLines).toEqual(["const gone = 3;"]);
    expect(files[1]?.addedLines).toEqual(["const only = 4;"]);
  });

  it("skips /dev/null and un-prefixed headers safely", () => {
    const patch = ["--- /dev/null", "+++ b/new-file.ts", "+content"].join("\n");
    const files = parseFilePatches(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.file).toBe("new-file.ts");
  });

  it("attributes a deleted file's removed lines via its --- header", () => {
    const patch = [
      "--- a/src/domain/legacy.ts",
      "+++ /dev/null",
      "@@ -1,2 0,0 @@",
      "-// TODO: remove this legacy module",
      "-// TODO: and its second marker",
    ].join("\n");
    const files = parseFilePatches(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.file).toBe("src/domain/legacy.ts");
    expect(files[0]?.removedLines).toHaveLength(2);
  });

  it("does not mistake a removed '--' line or an added '++' line for a file header", () => {
    const patch = [
      "--- a/src/domain/a.ts",
      "+++ b/src/domain/a.ts",
      "@@ -1,2 1,2 @@",
      // Raw diff lines: the removed line's content starts with "-- " (so the diff line starts
      // "--- ") and the added line's content starts with "++ " (diff line "+++ ") — neither may
      // be mistaken for a file header.
      "--- old lua style comment",
      "+++ new lua style value",
      "++ increment operator line",
    ].join("\n");
    const files = parseFilePatches(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.file).toBe("src/domain/a.ts");
    expect(files[0]?.removedLines).toEqual(["-- old lua style comment"]);
    expect(files[0]?.addedLines).toEqual(["++ new lua style value", "+ increment operator line"]);
  });

  it("marks git binary patches as uninspectable instead of treating them as empty text", () => {
    const patch = [
      "diff --git a/assets/data.bin b/assets/data.bin",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/assets/data.bin",
      "GIT binary patch",
      "literal 8",
      "zcmeAS@N?(o",
    ].join("\n");

    const files = parseFilePatches(patch);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ file: "assets/data.bin", binary: true });
    expect(files[0]?.addedLines).toHaveLength(0);
  });

  it("decodes Git-quoted UTF-8 paths while preserving binary attribution", () => {
    const patch = String.raw`diff --git "a/assets/\303\251.bin" "b/assets/\303\251.bin"
new file mode 100644
GIT binary patch
literal 8
zcmeAS@N?(o`;

    expect(parseFilePatches(patch)).toEqual([
      {
        file: "assets/é.bin",
        addedLines: [],
        removedLines: [],
        binary: true,
        uninspectableReasons: ["BINARY"],
      },
    ]);
  });

  it("marks gitlinks and rename-only changes as textually uninspectable", () => {
    const patch = [
      "diff --git a/vendor/sdk b/vendor/sdk",
      "new file mode 160000",
      "index 0000000..1234567",
      "--- /dev/null",
      "+++ b/vendor/sdk",
      "@@ -0,0 +1 @@",
      "+Subproject commit 1234567890abcdef1234567890abcdef12345678",
      "diff --git a/tests/fixtures/key.pem b/src/config/key.pem",
      "similarity index 100%",
      "rename from tests/fixtures/key.pem",
      "rename to src/config/key.pem",
    ].join("\n");

    const files = parseFilePatches(patch);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      file: "vendor/sdk",
      uninspectableReasons: ["GITLINK"],
    });
    expect(files[1]).toMatchObject({
      file: "src/config/key.pem",
      uninspectableReasons: ["RENAME_OR_COPY"],
    });
  });
});
