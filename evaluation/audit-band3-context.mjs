import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  await readFile(path.join(evaluationRoot, "phase-c", "manifest.json"), "utf8"),
);
const audit = JSON.parse(
  await readFile(
    path.join(evaluationRoot, "curator", "phase-c", "band3-context-audit.json"),
    "utf8",
  ),
);
const failures = [];
const oldOwnerIdentifiers =
  /b3-(?:config-provider-boundary-trace|dead-code-vs-live-discount-path|decoy-cache-source-of-truth|duplicate-service-owner|event-handler-owner-trace)/i;
const directiveLeakage = /(?:superseded by|unused by any live|correct owner|hidden grader)/i;

if (audit.map(({ id }) => id).join("\n") !== manifest.bands.band3.join("\n")) {
  failures.push("context audit tasks must exactly match the Band 3 manifest order");
}

for (const item of audit) {
  const publicRoot = path.join(evaluationRoot, "fixtures", "phase-c", item.id, "public");
  const repoRoot = path.join(publicRoot, "repo");
  const prompt = await readFile(path.join(publicRoot, "prompt.md"), "utf8");
  const ownerName = path.basename(item.defectOwner, ".mjs");
  const entrypoint = await readFile(path.join(repoRoot, item.entrypoint), "utf8");
  const meaningfulHops = item.behaviorPath.length - 1;

  if (item.classification !== "CONTEXT_TEST_STRONG") {
    failures.push(`${item.id}: frontier Band 3 task is not classified strong`);
  }
  if (meaningfulHops < 3) failures.push(`${item.id}: fewer than three behavior hops`);
  if (item.decoys.length < 3) failures.push(`${item.id}: fewer than three plausible decoys`);
  if (oldOwnerIdentifiers.test(prompt) || directiveLeakage.test(prompt)) {
    failures.push(`${item.id}: prompt leaks private ownership history`);
  }
  if (prompt.includes(item.defectOwner) || prompt.includes(ownerName)) {
    failures.push(`${item.id}: prompt names the defect owner`);
  }
  if (entrypoint.includes(item.defectOwner) || entrypoint.includes(ownerName)) {
    failures.push(`${item.id}: entrypoint imports the defect owner directly`);
  }

  for (const relative of [item.defectOwner, ...item.behaviorPath, ...item.decoys]) {
    const info = await stat(path.join(repoRoot, relative)).catch(() => null);
    if (!info?.isFile()) failures.push(`${item.id}: audit evidence is missing ${relative}`);
  }
}

if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(
  JSON.stringify({
    tasks: audit.length,
    classifications: { CONTEXT_TEST_STRONG: audit.length },
    minimumMeaningfulHops: Math.min(...audit.map((item) => item.behaviorPath.length - 1)),
    ownerLeakage: "PASS",
    directEntrypointOwnership: "PASS",
  }),
);
