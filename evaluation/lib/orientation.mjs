// Measured orientation analysis for Band 3 context tasks.
//
// AUDIT #1 found the previous audit circular: it read a `classification` field out of a JSON file,
// asserted it equalled CONTEXT_TEST_STRONG, and printed `{ CONTEXT_TEST_STRONG: 5 }`.
//
// AUDIT #2 found the replacement measured the wrong thing. It counted ESM import-graph hops and
// module out-degree and called them investigation difficulty. A coding agent does not breadth-first
// search an import graph: it reads the symptom, greps the vocabulary the symptom gives it, opens the
// two or three files that match, and reads. A six-hop import chain that one grep collapses is not a
// context test, and a module that imports two unrelated helpers is not a decision point.
//
// AUDIT #3 found decisionPoints itself still walked from the entrypoint (importGraph.shortestOwnerPath)
// even though investigationDepth had already been fixed to start from wherever the symptom vocabulary
// actually lands. A prompt that gives an exact, precise search term (a function signature, say) lets a
// reader skip straight past every entrypoint-adjacent fork; crediting those forks as "decision points"
// overstates a task's difficulty for exactly the tasks a precise prompt makes easiest. Decision points,
// investigation depth and the reported step-by-step path now all walk from the same landing point: the
// nearest file a realistic search from the public prompt actually reaches, preferring a search precise
// enough (few enough matches) that a reader would follow it with confidence over one that merely mentions
// the symptom in passing. A fork only counts if it sits on the route from THAT landing point, not from a
// generic entrypoint traversal the reader never performs.
//
// What this module measures now:
//
//   searchCollapse       for every realistic search term the PUBLIC prompt hands a reader, how many
//                        files match and whether the defect owner is among them. One search that
//                        returns a handful of files including the owner collapses the whole task.
//   landingPoint         the file a realistic, precise search from the prompt's own vocabulary would
//                        actually land a reader on -- preferred over the entrypoint as the start of
//                        the walk toward the owner, since that is where investigation really begins.
//   competingHypotheses  at each step from the landing point toward the owner, how many reachable
//                        neighbours could plausibly explain the symptom -- measured by whether they
//                        mention the task's declared symptom vocabulary, not by out-degree, and never
//                        counting a fork the landing point's own route bypasses.
//   investigationDepth   how many files a reader must open and reject after landing, before reaching
//                        the owner, along the shortest route the symptom vocabulary actually supports.
//   decoyStrength        whether declared decoys are reachable AND mention the symptom vocabulary,
//                        i.e. whether they can hold a reader's attention at all.
//
// Import-graph facts (including the entrypoint-rooted shortest path) are still reported, because they
// are true and useful context. They no longer drive the classification on their own, and as of Audit #3
// they no longer drive decisionPoints or investigationDepth either -- only the search-aware landing
// point's own route does.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Declared thresholds. Changing these changes classifications, so they live in one place and are
// echoed into every report.
export const THRESHOLDS = {
  // A search returning at most this many files, with the owner among them, collapses orientation.
  searchCollapseFiles: 3,
  // Files a reader must open and reject before the owner, for the task to be about orientation.
  minInvestigationDepth: 3,
  // Steps toward the owner that offer a genuine choice between symptom-plausible candidates.
  minDecisionPoints: 2,
  // Decoys that are both reachable and symptom-plausible.
  minCredibleDecoys: 2,
  // A repository whose modules are mostly unreachable is padding, not context.
  minReachableFraction: 0.35,
  minReachableModules: 8,
};

const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

// Terms a reader would actually type. Code-shaped identifiers from the prompt, plus quoted strings
// and backticked names, which is how prompts usually surface a symptom's vocabulary.
const CODE_IDENTIFIER = /\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][A-Z0-9_]{3,})\b/g;
const BACKTICKED = /`([^`\n]{2,60})`/g;
const PROSE_IDENTIFIERS = new Set(["JavaScript", "TypeError", "RangeError", "JSON", "UTF"]);

export async function analyzeOrientation({
  repoRoot,
  entrypoint,
  defectOwner,
  decoys = [],
  prompt,
  // Vocabulary that describes the OBSERVABLE symptom, taken from the public prompt. A neighbour that
  // mentions it is a module a reader could plausibly suspect.
  symptomTerms = [],
}) {
  const modules = await listModules(repoRoot);
  const graph = new Map();
  const sources = new Map();
  for (const relative of modules) {
    const source = await readFile(path.join(repoRoot, relative), "utf8");
    sources.set(relative, source);
    graph.set(relative, resolveImports(relative, source, modules));
  }

  const reachable = walk(graph, entrypoint);
  const ownerPath = shortestPath(graph, entrypoint, defectOwner);
  // Symptom vocabulary is matched on word boundaries, not as raw substrings. A module that happens
  // to contain "strategy" is not talking about a "rate", and counting it as symptom-plausible
  // silently inflated both the hypothesis space and the measured investigation depth.
  const mentions = (relative, terms) => {
    const source = sources.get(relative) ?? "";
    return terms.some((term) => wordBoundaryPattern(term).test(source));
  };

  // --- search collapse ---------------------------------------------------------------------------
  // Every realistic term the prompt gives a reader is tried against every file, regardless of
  // whether the term appears in the declared owner metadata.
  const searchTerms = extractSearchTerms(prompt ?? "");
  const searches = searchTerms.map((term) => {
    const files = modules.filter((relative) => (sources.get(relative) ?? "").includes(term));
    return {
      term,
      files: files.length,
      ownerAmong: files.includes(defectOwner),
      matched: files.slice(0, 6),
    };
  });
  const collapsingSearches = searches.filter(
    (search) =>
      search.ownerAmong && search.files > 0 && search.files <= THRESHOLDS.searchCollapseFiles,
  );

  // --- search-aware landing point ------------------------------------------------------------------
  // A reader does not start at the entrypoint: they start wherever a realistic search from the
  // prompt's own vocabulary lands them. A search term that returns few files is precise enough that a
  // reader would follow it with confidence -- that is a real landing point, not merely a mention. A
  // term with many hits is not decisive on its own, so a file it surfaces is a weaker (but still
  // considered) candidate. Preferring precise hits, then falling back to any symptom-bearing file, then
  // finally to the entrypoint itself keeps this well-defined even for tasks whose vocabulary is broad
  // or absent, while never crediting a start the reader would not realistically reach.
  const symptomBearingFiles = [...reachable].filter((relative) => mentions(relative, symptomTerms));
  const ownerSurfacedBySymptomVocabulary = mentions(defectOwner, symptomTerms);

  const routeFrom = (start) => {
    const route = shortestPath(graph, start, defectOwner);
    return route === null ? null : { start, route, depth: route.length - 1 };
  };
  const bestOf = (starts) =>
    starts
      .map(routeFrom)
      .filter((entry) => entry !== null)
      .toSorted((a, b) => a.depth - b.depth || (a.start < b.start ? -1 : 1))[0] ?? null;

  const preciseStarts = [
    ...new Set(
      searches
        .filter((search) => search.files > 0 && search.files <= THRESHOLDS.searchCollapseFiles)
        .flatMap((search) => search.matched),
    ),
  ];
  const broadStarts = symptomBearingFiles.filter((relative) => relative !== defectOwner);

  const landing =
    bestOf(preciseStarts) ?? bestOf(broadStarts) ?? (ownerPath && { start: entrypoint, route: ownerPath, depth: ownerPath.length - 1 });
  const landingPrecision = landing === null ? null : preciseStarts.includes(landing.start)
    ? "PRECISE_SEARCH"
    : landing.start === entrypoint && landing.route === ownerPath
      ? "ENTRYPOINT_FALLBACK"
      : "SYMPTOM_MENTION";
  const investigationPath = landing?.route ?? ownerPath;

  // --- competing hypotheses along the route from the landing point to the owner --------------------
  // A step is a decision point only when more than one reachable neighbour mentions the symptom
  // vocabulary, i.e. when a reader genuinely has to choose which one to open -- and only when that
  // step sits on the route from the landing point, not on a generic entrypoint traversal the reader
  // never performs because a precise search already put them somewhere further along.
  const steps = (investigationPath ?? []).slice(0, -1).map((node, index) => {
    const next = investigationPath[index + 1];
    const neighbours = graph.get(node) ?? [];
    const plausible = neighbours.filter((edge) => mentions(edge, symptomTerms));
    return {
      module: node,
      next,
      neighbours: neighbours.length,
      symptomPlausibleNeighbours: plausible.length,
      alternatives: plausible.filter((edge) => edge !== next),
    };
  });
  const decisionPoints = steps.filter((step) => step.symptomPlausibleNeighbours >= 2).length;

  // --- investigation depth ------------------------------------------------------------------------
  // How far the reader must travel from the landing point to reach the owner.
  const investigationDepth = landing?.depth ?? (ownerPath?.length ?? 1) - 1;

  // --- decoys -------------------------------------------------------------------------------------
  const decoyEvidence = decoys.map((relative) => ({
    module: relative,
    exists: modules.includes(relative),
    reachable: reachable.has(relative),
    symptomPlausible: modules.includes(relative) && mentions(relative, symptomTerms),
    onOwnerPath: ownerPath?.includes(relative) ?? false,
    importedBy: [...graph.entries()].filter(([, edges]) => edges.includes(relative)).length,
  }));
  const credibleDecoys = decoyEvidence.filter(
    (entry) => entry.reachable && entry.symptomPlausible && !entry.onOwnerPath,
  ).length;

  const orphans = [...reachable].filter(
    (relative) =>
      relative !== entrypoint && [...graph.values()].every((edges) => !edges.includes(relative)),
  );

  const evidence = {
    totalModules: modules.length,
    reachableModules: reachable.size,
    reachableFraction:
      modules.length === 0 ? 0 : Number((reachable.size / modules.length).toFixed(3)),
    entrypoint,
    defectOwner,
    ownerReachable: reachable.has(defectOwner),
    symptomTerms,
    // Import-graph facts, reported but no longer the basis of the verdict.
    importGraph: {
      shortestOwnerPath: ownerPath,
      shortestOwnerPathHops: ownerPath === null ? null : ownerPath.length - 1,
      entrypointImportsOwner: (graph.get(entrypoint) ?? []).includes(defectOwner),
      orphanModules: orphans,
    },
    search: {
      termsTried: searches.length,
      searches,
      collapsingSearches,
      minimumFilesForAnOwnerRevealingSearch:
        searches.filter((s) => s.ownerAmong).length === 0
          ? null
          : Math.min(...searches.filter((s) => s.ownerAmong).map((s) => s.files)),
    },
    investigation: {
      // How many files a grep for the symptom vocabulary surfaces: the reader's hypothesis space.
      hypothesisBreadth: symptomBearingFiles.length,
      // Whether that grep lands on the defect owner itself.
      ownerSurfacedBySymptomVocabulary,
      // The file a realistic search actually lands a reader on, and how confident that landing is:
      // PRECISE_SEARCH (a search term with few enough matches to follow directly), SYMPTOM_MENTION (a
      // broader file the vocabulary merely surfaces, used only when no search is precise), or
      // ENTRYPOINT_FALLBACK (no symptom vocabulary reaches anything useful, so the walk starts at the
      // entrypoint as it always did before this landing-point measurement existed).
      landingFile: landing?.start ?? null,
      landingPrecision,
      landingPath: investigationPath,
      // Edges from the landing point to the owner, along landingPath -- not from the entrypoint.
      investigationDepth,
      steps,
      decisionPoints,
    },
    decoys: decoyEvidence,
    credibleDecoys,
  };
  return { evidence, ...classify(evidence) };
}

/**
 * Derives a classification from measured evidence. Every reason names the measurement that produced
 * it, so an auditor can re-derive the verdict or reject the threshold without re-running anything.
 */
export function classify(evidence) {
  const disqualifying = [];
  const weakening = [];
  const { search, investigation, importGraph } = evidence;

  if (importGraph.shortestOwnerPath === null) {
    disqualifying.push("the defect owner is not reachable from the entrypoint");
  }
  if (evidence.reachableModules < THRESHOLDS.minReachableModules) {
    disqualifying.push(
      `only ${evidence.reachableModules} modules are reachable (threshold ${THRESHOLDS.minReachableModules})`,
    );
  }
  if (importGraph.entrypointImportsOwner) {
    disqualifying.push("the entrypoint imports the defect owner directly");
  }
  if (evidence.symptomTerms.length === 0) {
    disqualifying.push("no symptom vocabulary was declared, so orientation cannot be measured");
  }

  // The finding that matters: one realistic search that lands on the owner ends the investigation.
  if (search.collapsingSearches.length > 0) {
    const worst = search.collapsingSearches
      .map((entry) => `"${entry.term}" -> ${entry.files} file(s)`)
      .join(", ");
    weakening.push(
      `a realistic search from the public prompt reaches the defect owner directly: ${worst} (threshold more than ${THRESHOLDS.searchCollapseFiles} files)`,
    );
  }
  // The decisive case: the vocabulary the prompt hands the reader appears in the defect owner, so
  // grepping the symptom lands on the culprit rather than on the places that exhibit it.
  if (investigation.ownerSurfacedBySymptomVocabulary) {
    weakening.push(
      "the defect owner itself contains the symptom vocabulary, so a search for the reported symptom surfaces it directly",
    );
  }
  if (investigation.investigationDepth < THRESHOLDS.minInvestigationDepth) {
    weakening.push(
      `only ${investigation.investigationDepth} hop(s) separate the nearest other symptom-bearing file from the owner (threshold ${THRESHOLDS.minInvestigationDepth})`,
    );
  }
  if (investigation.decisionPoints < THRESHOLDS.minDecisionPoints) {
    weakening.push(
      `only ${investigation.decisionPoints} step(s) toward the owner offer a choice between symptom-plausible modules (threshold ${THRESHOLDS.minDecisionPoints})`,
    );
  }
  if (evidence.credibleDecoys < THRESHOLDS.minCredibleDecoys) {
    weakening.push(
      `only ${evidence.credibleDecoys} decoy(s) are both reachable and symptom-plausible (threshold ${THRESHOLDS.minCredibleDecoys})`,
    );
  }
  if (evidence.reachableFraction < THRESHOLDS.minReachableFraction) {
    weakening.push(
      `only ${(evidence.reachableFraction * 100).toFixed(1)}% of modules are reachable (threshold ${(THRESHOLDS.minReachableFraction * 100).toFixed(0)}%)`,
    );
  }
  if (importGraph.orphanModules.length > 0) {
    weakening.push(
      `${importGraph.orphanModules.length} reachable module(s) are imported by nothing: ${importGraph.orphanModules.slice(0, 4).join(", ")}`,
    );
  }

  const classification =
    disqualifying.length > 0
      ? "NOT_A_CONTEXT_TEST"
      : weakening.length > 0
        ? "CONTEXT_TEST_WEAK"
        : "CONTEXT_TEST_STRONG";
  return { classification, disqualifying, weakening };
}

/**
 * Search terms a reader would realistically try, taken from the public prompt alone: code-shaped
 * identifiers and anything the prompt puts in backticks. Deliberately not filtered by whether the
 * term appears in the declared owner -- that filter is what let a revealing term go unnoticed.
 */
export function extractSearchTerms(prompt) {
  const identifiers = [...prompt.matchAll(CODE_IDENTIFIER)].map((match) => match[0]);
  const quoted = [...prompt.matchAll(BACKTICKED)].map((match) => match[1]);
  return [...new Set([...identifiers, ...quoted])]
    .filter((term) => !PROSE_IDENTIFIERS.has(term))
    .filter((term) => term.trim().length >= 3)
    .toSorted();
}

async function listModules(repoRoot) {
  const entries = await readdir(repoRoot, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) =>
      path
        .relative(repoRoot, path.join(entry.parentPath ?? entry.path, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

function resolveImports(from, source, modules) {
  const edges = new Set();
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith(".")) continue;
    const resolved = path
      .normalize(path.join(path.dirname(from), specifier))
      .split(path.sep)
      .join("/");
    if (modules.includes(resolved)) edges.add(resolved);
  }
  return [...edges];
}

const BOUNDARY_CACHE = new Map();
function wordBoundaryPattern(term) {
  let pattern = BOUNDARY_CACHE.get(term);
  if (!pattern) {
    const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    pattern = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`);
    BOUNDARY_CACHE.set(term, pattern);
  }
  return pattern;
}

function walk(graph, entrypoint) {
  const seen = new Set();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const node = queue.shift();
    if (seen.has(node) || !graph.has(node)) continue;
    seen.add(node);
    queue.push(...(graph.get(node) ?? []));
  }
  return seen;
}

function shortestPath(graph, from, to) {
  const previous = new Map([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === to) {
      const chain = [];
      for (let step = node; step !== null; step = previous.get(step)) chain.unshift(step);
      return chain;
    }
    for (const edge of graph.get(node) ?? []) {
      if (!previous.has(edge)) {
        previous.set(edge, node);
        queue.push(edge);
      }
    }
  }
  return null;
}
