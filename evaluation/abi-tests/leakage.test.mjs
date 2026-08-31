// Leakage-detection regression tests for the independent-audit repair.
//
// M3: the previous detector matched a nine-word vocabulary on delimiter boundaries only. It missed
// src/answer.mjs, src/expected-patch.mjs and content such as "the correct fix is ...".
//
// These tests plant leaks and assert they are detected, and plant benign files that share a
// substring with the vocabulary and assert they are not. Detection here is lexical: it proves the
// declared vocabulary is enforced, not that a workspace is semantically free of hints.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  findPrivateLeakage,
  inspectContent,
  inspectPath,
  loadLeakagePolicy,
  tokenizePath,
} from "../lib/leakage.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

const PLANTED_FILENAMES = [
  "src/answer.mjs",
  "src/answers.mjs",
  "src/expected-patch.mjs",
  "src/expected_patch.mjs",
  "src/expectedPatch.mjs",
  "src/expected-output.mjs",
  "src/adversarial-cases.mjs",
  "src/attack-two.mjs",
  "src/hidden-tests.mjs",
  "src/golden-output.mjs",
  "src/reference-impl.mjs",
  "src/wrong-impl.mjs",
  "src/alternative-impl.mjs",
  "src/solution.mjs",
  "src/spoiler.mjs",
  "src/oracle.mjs",
  "src/private-notes.mjs",
  "src/ground-truth.mjs",
  "src/curator/notes.mjs",
  "src/graders/one.mjs",
];

const PLANTED_CONTENT = [
  "// the correct fix is to validate before saving\n",
  "// The correct answer is a RangeError.\n",
  "// the solution is to reorder the write\n",
  "// the grader expects a RangeError here\n",
  "// the grader will check the store afterwards\n",
  "/* reference implementation follows */\n",
  "// curator note: keep this private\n",
  "// expected patch: move the guard up\n",
  "// hidden test asserts the store is untouched\n",
  "// do not show this to the candidate\n",
  "// ground truth: three deliveries\n",
  "// golden output is 116.64\n",
  "// this is the known-wrong variant\n",
  "// cheat sheet for the grader\n",
];

// Files that share a substring with the vocabulary but are legitimate fixture code.
const BENIGN = {
  "src/apply-patch.mjs": "export function applyPatch(record, patch) { return record; }\n",
  "src/audit-log.mjs": "export const log = [];\n",
  "src/report-writer.mjs": "export function writeReportFile() {}\n",
  "src/validators.mjs": "// assert the value is within the expected range for this call\n",
  "src/patch-utils.mjs": "export const patched = true;\n",
  "src/reporter.mjs": "// answering a request is not a leak term on its own\n",
};

test("planted private filenames are detected", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "src", "curator"), { recursive: true });
  await mkdir(path.join(root, "src", "graders"), { recursive: true });
  for (const relative of PLANTED_FILENAMES) {
    await writeFile(path.join(root, relative), "export const x = 1;\n", "utf8");
  }
  const flagged = flaggedPaths(await findPrivateLeakage(root));
  const missed = PLANTED_FILENAMES.filter((relative) => !flagged.has(relative));
  assert.deepEqual(missed, [], `undetected private filenames: ${missed.join(", ")}`);
});

test("planted private content is detected", async () => {
  const policy = await loadLeakagePolicy();
  const missed = PLANTED_CONTENT.filter((content) => inspectContent(content, policy) === null);
  assert.deepEqual(missed, [], `undetected private content: ${missed.join(" | ")}`);
});

test("planted private content is detected end to end", async () => {
  const root = await fixture();
  for (const [index, content] of PLANTED_CONTENT.entries()) {
    await writeFile(path.join(root, "src", `note-${index}.mjs`), content, "utf8");
  }
  const flagged = flaggedPaths(await findPrivateLeakage(root));
  const missed = PLANTED_CONTENT.map((_, index) => `src/note-${index}.mjs`).filter(
    (relative) => !flagged.has(relative),
  );
  assert.deepEqual(missed, [], `undetected private content files: ${missed.join(", ")}`);
});

test("legitimate fixture files are not flagged", async () => {
  const root = await fixture();
  for (const [relative, content] of Object.entries(BENIGN)) {
    await writeFile(path.join(root, relative), content, "utf8");
  }
  const flagged = [...flaggedPaths(await findPrivateLeakage(root))];
  assert.deepEqual(flagged, [], `false positives: ${flagged.join(", ")}`);
});

test("task-specific forbidden strings are enforced", async () => {
  const policy = await loadLeakagePolicy();
  assert.ok(
    inspectContent("writing to sub/../../PWNED.txt escapes", policy, "report-output-path-boundary"),
    "task-specific string must be detected for its own task",
  );
  assert.equal(
    inspectContent("writing to sub/../../PWNED.txt escapes", policy, "clamp-number-util"),
    null,
    "a task-specific string must not apply to another task",
  );
});

test("path tokenization splits separators and camelCase", () => {
  assert.deepEqual(tokenizePath("src/expectedPatch.mjs"), ["src", "expected", "patch", "mjs"]);
  assert.deepEqual(tokenizePath("src/expected_patch.mjs"), ["src", "expected", "patch", "mjs"]);
  assert.deepEqual(tokenizePath("a\\b-c.d"), ["a", "b", "c", "d"]);
});

test("the allowlist is honoured and scoped to the exact path", async () => {
  const policy = await loadLeakagePolicy();
  assert.equal(inspectPath("src/apply-patch.mjs", policy), null);
  assert.ok(
    inspectPath("src/expected-patch.mjs", policy),
    "a non-allowlisted path must still flag",
  );
});

test("an empty workspace reports no leakage", async () => {
  const root = await fixture();
  assert.deepEqual(await findPrivateLeakage(root), []);
});

function flaggedPaths(leaks) {
  return new Set(
    leaks.map((leak) =>
      leak
        .replace(/^(?:path|content):/, "")
        .replace(/ \(.*\)$/, "")
        .replaceAll("\\", "/"),
    ),
  );
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "maf-leak-test-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "seed.mjs"), "export const seed = true;\n", "utf8");
  return root;
}
