// Cross-suite distinctness audit.
//
// The independent audit of snapshot bb326527 found this script emitting promptLeakage,
// crossTaskIdentifierLeakage, repeatedSolutions and copiedHiddenBehavior as the literal string
// "PASS", and the Band 3 summary as a hard-coded `{ strong: 5, weak: 0, notAContextTest: 0 }`.
//
// Every field below is a measured value. copiedHiddenBehavior is now an actual similarity
// measurement over grader sources rather than an assertion, grader-awareness of each stored attack
// is measured against its own grader, and the Band 3 counts are derived by running the orientation
// analyzer rather than read from a stored classification field.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeOrientation } from "./lib/orientation.mjs";

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

// Similarity thresholds. Declared here so the numbers below can be disputed on their merits.
const GRADER_SIMILARITY_LIMIT = 0.6;
const ATTACK_AWARENESS_LIMIT = 0.35;
const FIXTURE_OVERLAP_LIMIT = 0.5;

const privatePromptPattern =
  /(?:hidden grader|reference implementation|expected patch|correct owner|private artifact|known[- ]wrong|curator note)/i;

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

// --- prompt leakage, measured -------------------------------------------------------------------

const promptFindings = { privateGuidance: [], crossTaskIdentifier: [] };
for (const item of review.tasks) {
  const prompt = await readFile(
    path.join(evaluationRoot, "fixtures", item.phase, item.id, "public", "prompt.md"),
    "utf8",
  );
  if (privatePromptPattern.test(prompt)) promptFindings.privateGuidance.push(item.id);
  for (const otherId of taskIds) {
    if (otherId !== item.id && prompt.includes(otherId)) {
      promptFindings.crossTaskIdentifier.push(`${item.id} -> ${otherId}`);
    }
  }
}
failures.push(
  ...promptFindings.privateGuidance.map((id) => `${id}: prompt leaks private guidance`),
);
failures.push(
  ...promptFindings.crossTaskIdentifier.map(
    (entry) => `prompt leaks another task identifier: ${entry}`,
  ),
);

// --- overlap reviews ---------------------------------------------------------------------------

for (const overlap of review.overlapReviews) {
  if (overlap.verdict !== "DISTINCT" || overlap.tasks.length !== 2 || !overlap.reason) {
    failures.push(`invalid overlap review: ${JSON.stringify(overlap.tasks)}`);
  }
  for (const id of overlap.tasks) {
    if (!taskIds.includes(id)) failures.push(`overlap review references unknown task ${id}`);
  }
}

// --- candidate corpus, measured ------------------------------------------------------------------

const implementations = [];
const attacks = [];
const wrong = [];
const overlaysByPhase = {};
for (const phase of ["phase-b", "phase-c"]) {
  const overlays = await loadOverlays(phase);
  overlaysByPhase[phase] = overlays;
  for (const id of expected.filter((item) => item.phase === phase).map(({ id }) => id)) {
    for (const candidate of ["reference", "alternative"]) {
      implementations.push({
        key: `${phase}/${id}/${candidate}`,
        value: overlays[candidate]?.[id],
      });
    }
    attacks.push({ key: `${phase}/${id}/attack`, phase, id, value: overlays.attack?.[id] });
    wrong.push({ key: `${phase}/${id}/wrong`, value: overlays.wrong?.[id] });
    if (overlays.probe?.[id]) {
      implementations.push({ key: `${phase}/${id}/probe`, value: overlays.probe[id] });
    }
  }
}
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
const repeatedWrong = [];
for (const group of duplicateGroups(wrong)) {
  repeatedWrong.push(group);
  if (group.some((key) => !allowedWrongReuse.has(key))) {
    failures.push(`unreviewed repeated wrong candidate: ${group.join(", ")}`);
  }
}

// --- copied hidden behavior, measured ------------------------------------------------------------
//
// Two graders that assert the same behavior in the same way make a pair of tasks a reskin rather
// than two experiments. Similarity is Jaccard over 5-token shingles of the normalized grader source
// for each task, extracted from the shared grader modules.

const graderSources = await loadGraderSources();
const graderPairs = [];
const graderIds = [...graderSources.keys()].toSorted();
for (let i = 0; i < graderIds.length; i += 1) {
  for (let j = i + 1; j < graderIds.length; j += 1) {
    const similarity = jaccard(
      shingles(graderSources.get(graderIds[i])),
      shingles(graderSources.get(graderIds[j])),
    );
    if (similarity >= GRADER_SIMILARITY_LIMIT) {
      graderPairs.push({ tasks: [graderIds[i], graderIds[j]], similarity: round(similarity) });
    }
  }
}
for (const pair of graderPairs) {
  failures.push(
    `graders for ${pair.tasks.join(" and ")} are ${(pair.similarity * 100).toFixed(0)}% similar (limit ${(GRADER_SIMILARITY_LIMIT * 100).toFixed(0)}%)`,
  );
}

// --- attack independence, measured ---------------------------------------------------------------
//
// A stored attack should challenge the public contract, not mirror the hidden grader. Awareness is
// the fraction of an attack's shingles that also appear in its own grader's source.

const attackAwareness = [];
for (const attack of attacks) {
  const source = graderSources.get(attack.id);
  if (!source || !attack.value) continue;
  const attackShingles = shingles(Object.values(attack.value).join("\n"));
  const graderShingles = shingles(source);
  const shared = [...attackShingles].filter((shingle) => graderShingles.has(shingle)).length;
  const awareness = attackShingles.size === 0 ? 0 : shared / attackShingles.size;
  attackAwareness.push({ task: attack.id, awareness: round(awareness) });
}
const graderAwareAttacks = attackAwareness.filter(
  (entry) => entry.awareness >= ATTACK_AWARENESS_LIMIT,
);
for (const entry of graderAwareAttacks) {
  failures.push(
    `attack for ${entry.task} shares ${(entry.awareness * 100).toFixed(0)}% of its shingles with its own grader (limit ${(ATTACK_AWARENESS_LIMIT * 100).toFixed(0)}%)`,
  );
}

// --- cross-fixture reskin detection, measured -----------------------------------------------------
//
// The audited snapshot built all five Band 3 tasks from one shared 50-module application, so
// solving one task taught a solver the next task's layout. Overlap is measured two ways: the
// fraction of module paths two fixtures share, and Jaccard similarity over their concatenated
// sources. Both are reported; the path overlap is the one that catches a shared skeleton.

const fixtureProfiles = new Map();
for (const { phase, id } of expected) {
  const repoRoot = path.join(evaluationRoot, "fixtures", phase, id, "public", "repo");
  const entries = await readdir(repoRoot, { recursive: true, withFileTypes: true });
  const modulePaths = new Set();
  let source = "";
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? entry.path, entry.name);
    modulePaths.add(path.relative(repoRoot, absolute).split(path.sep).join("/"));
    source += await readFile(absolute, "utf8");
  }
  fixtureProfiles.set(id, { modulePaths, shingles: shingles(source) });
}
const fixturePairs = [];
let maxPathOverlap = 0;
let maxSourceOverlap = 0;
for (let i = 0; i < taskIds.length; i += 1) {
  for (let j = i + 1; j < taskIds.length; j += 1) {
    const left = fixtureProfiles.get(taskIds[i]);
    const right = fixtureProfiles.get(taskIds[j]);
    const pathOverlap = jaccard(left.modulePaths, right.modulePaths);
    const sourceOverlap = jaccard(left.shingles, right.shingles);
    maxPathOverlap = Math.max(maxPathOverlap, pathOverlap);
    maxSourceOverlap = Math.max(maxSourceOverlap, sourceOverlap);
    if (pathOverlap >= FIXTURE_OVERLAP_LIMIT || sourceOverlap >= FIXTURE_OVERLAP_LIMIT) {
      fixturePairs.push({
        tasks: [taskIds[i], taskIds[j]],
        modulePathOverlap: round(pathOverlap),
        sourceOverlap: round(sourceOverlap),
      });
    }
  }
}
for (const pair of fixturePairs) {
  failures.push(
    `fixtures for ${pair.tasks.join(" and ")} overlap: ${(pair.modulePathOverlap * 100).toFixed(0)}% of module paths, ${(pair.sourceOverlap * 100).toFixed(0)}% of source (limit ${(FIXTURE_OVERLAP_LIMIT * 100).toFixed(0)}%)`,
  );
}

// --- band 3, derived from measurement -------------------------------------------------------------

const band3Declared = await readJson(
  path.join(evaluationRoot, "curator", "phase-c", "band3-context-audit.json"),
);
const band3Counts = { CONTEXT_TEST_STRONG: 0, CONTEXT_TEST_WEAK: 0, NOT_A_CONTEXT_TEST: 0 };
const band3Tasks = [];
for (const item of band3Declared) {
  const publicRoot = path.join(evaluationRoot, "fixtures", "phase-c", item.id, "public");
  const analysis = await analyzeOrientation({
    repoRoot: path.join(publicRoot, "repo"),
    entrypoint: item.entrypoint,
    defectOwner: item.defectOwner,
    decoys: item.decoys ?? [],
    prompt: await readFile(path.join(publicRoot, "prompt.md"), "utf8"),
    symptomTerms: item.symptomTerms ?? [],
  });
  band3Counts[analysis.classification] += 1;
  band3Tasks.push({ id: item.id, classification: analysis.classification });
}
if (band3Counts.NOT_A_CONTEXT_TEST > 0) {
  failures.push(
    `Band 3 contains ${band3Counts.NOT_A_CONTEXT_TEST} task(s) measured NOT_A_CONTEXT_TEST: ${band3Tasks
      .filter((t) => t.classification === "NOT_A_CONTEXT_TEST")
      .map((t) => t.id)
      .join(", ")}`,
  );
}

// --- report ---------------------------------------------------------------------------------------

console.log(
  JSON.stringify(
    {
      tasks: expected.length,
      uniqueBehaviorSignatures: new Set(review.tasks.map((t) => t.behaviorSignature)).size,
      reviewedCategoryOverlaps: review.overlapReviews.length,
      correctImplementationFingerprints: new Set(
        implementations.map(({ value }) => fingerprint(value)),
      ).size,
      correctImplementations: implementations.length,
      uniqueAttackFingerprints: new Set(attacks.map(({ value }) => fingerprint(value))).size,
      attacks: attacks.length,
      reviewedIntentionalWrongReuse: review.intentionalInvalidCandidateReuse.length,
      promptLeakage: {
        measurement:
          "lexical scan of every public prompt for private guidance and other task identifiers",
        promptsScanned: review.tasks.length,
        privateGuidanceFindings: promptFindings.privateGuidance,
        crossTaskIdentifierFindings: promptFindings.crossTaskIdentifier,
      },
      repeatedSolutions: {
        measurement: "sha-256 fingerprints of every correct and attack overlay",
        duplicateCorrectImplementations: duplicateGroups(implementations).map((g) => g.join(", ")),
        duplicateAttacks: duplicateGroups(attacks).map((g) => g.join(", ")),
        repeatedWrongCandidates: repeatedWrong.map((g) => g.join(", ")),
      },
      copiedHiddenBehavior: {
        measurement: `Jaccard similarity over 5-token shingles of each task's grader source; limit ${GRADER_SIMILARITY_LIMIT}`,
        gradersCompared: graderIds.length,
        pairsCompared: (graderIds.length * (graderIds.length - 1)) / 2,
        pairsOverLimit: graderPairs,
        maxSimilarity: round(maxPairSimilarity(graderIds, graderSources)),
      },
      attackIndependence: {
        measurement: `fraction of each attack's shingles also present in its own grader source; limit ${ATTACK_AWARENESS_LIMIT}`,
        attacksMeasured: attackAwareness.length,
        overLimit: graderAwareAttacks,
        maxAwareness:
          attackAwareness.length === 0
            ? null
            : Math.max(...attackAwareness.map((e) => e.awareness)),
        perTask: attackAwareness.toSorted((a, b) => b.awareness - a.awareness),
      },
      band3: {
        measurement:
          "orientation analyzer run over each Band 3 fixture; classification derived, not read",
        counts: band3Counts,
        tasks: band3Tasks,
      },
      fixtureDistinctness: {
        measurement: `pairwise module-path Jaccard and 5-token source Jaccard across all fixtures; limit ${FIXTURE_OVERLAP_LIMIT}`,
        fixturesCompared: taskIds.length,
        pairsCompared: (taskIds.length * (taskIds.length - 1)) / 2,
        maxModulePathOverlap: round(maxPathOverlap),
        maxSourceOverlap: round(maxSourceOverlap),
        pairsOverLimit: fixturePairs,
      },
      notChecked: {
        semanticReskinDetection: "NOT_CHECKED",
        promptParaphraseOverlap: "NOT_CHECKED",
      },
      failures,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;

// --- helpers ---------------------------------------------------------------------------------------

async function loadGraderSources() {
  // Each task's grader body lives in a shared module keyed by task id. Extract per-task sources so
  // similarity is measured between task graders, not between the modules that contain them.
  const sources = new Map();
  const modules = [
    path.join(evaluationRoot, "curator", "phase-b", "graders.mjs"),
    path.join(evaluationRoot, "curator", "phase-c", "graders-band12.mjs"),
    path.join(evaluationRoot, "curator", "phase-c", "graders-band3.mjs"),
  ];
  for (const module of modules) {
    const text = await readFile(module, "utf8");
    const starts = [...text.matchAll(/^ {2}"([a-z0-9-]+)":\s*async\s*\(/gm)];
    for (const [index, match] of starts.entries()) {
      const from = match.index;
      const to = index + 1 < starts.length ? starts[index + 1].index : text.length;
      sources.set(match[1], text.slice(from, to));
    }
  }
  for (const id of taskIds) {
    if (!sources.has(id)) failures.push(`could not extract a grader source for ${id}`);
  }
  return sources;
}

function shingles(source, size = 5) {
  const tokens =
    String(source)
      .replaceAll(/\/\/[^\n]*/g, " ")
      .replaceAll(/\s+/g, " ")
      .match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? [];
  const set = new Set();
  for (let index = 0; index + size <= tokens.length; index += 1) {
    set.add(tokens.slice(index, index + size).join(" "));
  }
  return set;
}

function jaccard(left, right) {
  if (left.size === 0 && right.size === 0) return 1;
  const intersection = [...left].filter((value) => right.has(value)).length;
  return intersection / (left.size + right.size - intersection);
}

function maxPairSimilarity(ids, sources) {
  let max = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      max = Math.max(max, jaccard(shingles(sources.get(ids[i])), shingles(sources.get(ids[j]))));
    }
  }
  return max;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

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
