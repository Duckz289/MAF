import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evaluationRoot = path.dirname(fileURLToPath(import.meta.url));
const review = await readJson(path.join(evaluationRoot, "curator", "cross-suite-review.json"));
const phaseB = await readJson(path.join(evaluationRoot, "phase-b", "manifest.json"));
const phaseC = await readJson(path.join(evaluationRoot, "phase-c", "manifest.json"));
const expected = [
  ...phaseB.tasks.map(([id]) => ({ phase: "phase-b", id })),
  ...Object.values(phaseC.bands)
    .flat()
    .map((id) => ({ phase: "phase-c", id })),
];
const failures = [];
const taskIds = expected.map(({ id }) => id);
const privatePromptPattern =
  /(?:hidden grader|reference implementation|expected patch|correct owner|private artifact|b3-config-provider-boundary-trace|b3-dead-code-vs-live-discount-path|b3-decoy-cache-source-of-truth|b3-duplicate-service-owner|b3-event-handler-owner-trace)/i;

if (
  review.tasks.map(({ phase, id }) => `${phase}/${id}`).join("\n") !==
  expected.map(({ phase, id }) => `${phase}/${id}`).join("\n")
) {
  failures.push("review tasks must exactly match manifest order");
}
assertUnique(
  review.tasks.map(({ behaviorSignature }) => behaviorSignature),
  "behavior signature",
);

for (const item of review.tasks) {
  const promptPath = path.join(
    evaluationRoot,
    "fixtures",
    item.phase,
    item.id,
    "public",
    "prompt.md",
  );
  const prompt = await readFile(promptPath, "utf8");
  if (privatePromptPattern.test(prompt)) failures.push(`${item.id}: prompt leaks private guidance`);
  for (const otherId of taskIds) {
    if (otherId !== item.id && prompt.includes(otherId)) {
      failures.push(`${item.id}: prompt leaks another task identifier ${otherId}`);
    }
  }
}

for (const overlap of review.overlapReviews) {
  if (overlap.verdict !== "DISTINCT" || overlap.tasks.length !== 2 || !overlap.reason) {
    failures.push(`invalid overlap review: ${JSON.stringify(overlap.tasks)}`);
  }
  for (const id of overlap.tasks) {
    if (!taskIds.includes(id)) failures.push(`overlap review references unknown task ${id}`);
  }
}

const implementations = [];
const attacks = [];
const wrong = [];
for (const phase of ["phase-b", "phase-c"]) {
  const overlays = await loadOverlays(phase);
  const phaseTaskIds = expected.filter((item) => item.phase === phase).map(({ id }) => id);
  for (const id of phaseTaskIds) {
    for (const candidate of ["reference", "alternative"]) {
      implementations.push({
        key: `${phase}/${id}/${candidate}`,
        value: overlays[candidate]?.[id],
      });
    }
    attacks.push({ key: `${phase}/${id}/attack`, value: overlays.attack?.[id] });
    wrong.push({ key: `${phase}/${id}/wrong`, value: overlays.wrong?.[id] });
    if (overlays.probe?.[id]) {
      implementations.push({ key: `${phase}/${id}/probe`, value: overlays.probe[id] });
    }
  }
}
if (implementations.length !== 83)
  failures.push(`expected 83 correct implementations, found ${implementations.length}`);
if (attacks.length !== 29) failures.push(`expected 29 attacks, found ${attacks.length}`);
if (wrong.length !== 29) failures.push(`expected 29 wrong candidates, found ${wrong.length}`);
for (const item of [...implementations, ...attacks, ...wrong]) {
  if (!item.value) failures.push(`${item.key}: missing overlay`);
}
assertUnique(
  implementations.map(({ value }) => fingerprint(value)),
  "correct implementation",
);
assertUnique(
  attacks.map(({ value }) => fingerprint(value)),
  "attack implementation",
);

const allowedWrongReuse = new Set(
  review.intentionalInvalidCandidateReuse.flatMap(({ tasks }) =>
    tasks.map((id) => wrong.find((item) => item.key.includes(`/${id}/`))?.key),
  ),
);
for (const group of duplicateGroups(wrong)) {
  if (group.some((key) => !allowedWrongReuse.has(key))) {
    failures.push(`unreviewed repeated wrong candidate: ${group.join(", ")}`);
  }
}

const band3Audit = await readJson(
  path.join(evaluationRoot, "curator", "phase-c", "band3-context-audit.json"),
);
if (
  band3Audit.length !== 5 ||
  band3Audit.some(({ classification }) => classification !== "CONTEXT_TEST_STRONG")
) {
  failures.push("all five Band 3 tasks must remain CONTEXT_TEST_STRONG");
}

if (failures.length > 0) throw new Error(failures.join("\n"));
console.log(
  JSON.stringify({
    tasks: expected.length,
    uniqueBehaviorSignatures: review.tasks.length,
    reviewedCategoryOverlaps: review.overlapReviews.length,
    correctImplementationFingerprints: implementations.length,
    uniqueAttackFingerprints: attacks.length,
    reviewedIntentionalWrongReuse: review.intentionalInvalidCandidateReuse.length,
    promptLeakage: "PASS",
    crossTaskIdentifierLeakage: "PASS",
    repeatedSolutions: "PASS",
    copiedHiddenBehavior: "PASS",
    band3: { strong: 5, weak: 0, notAContextTest: 0 },
  }),
);

async function loadOverlays(phase) {
  const files = ["overlays.json"];
  if (phase === "phase-c") files.push("overlays-band3.json");
  files.push("overlays-hardening.json");
  const merged = {};
  for (const file of files) {
    const document = await readJson(path.join(evaluationRoot, "curator", phase, file));
    for (const [candidate, tasks] of Object.entries(document)) {
      merged[candidate] = { ...merged[candidate], ...tasks };
    }
  }
  return merged;
}

function duplicateGroups(items) {
  const groups = new Map();
  for (const { key, value } of items) {
    const hash = fingerprint(value);
    groups.set(hash, [...(groups.get(hash) ?? []), key]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function fingerprint(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) failures.push(`${label}s are not unique`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
