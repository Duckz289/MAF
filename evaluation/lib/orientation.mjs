// Measured orientation analysis for Band 3 context tasks.
//
// The independent audit of snapshot bb326527 found the previous Band 3 audit circular: it read a
// `classification` field out of a JSON file, asserted that field equalled CONTEXT_TEST_STRONG, and
// then printed `{ CONTEXT_TEST_STRONG: 5 }`. It also treated a hand-authored `behaviorPath` as if
// it were measured, and reported `ownerLeakage: "PASS"` as a literal.
//
// This module measures the repository instead. It parses the ESM import graph, walks it from the
// declared entrypoint, and derives every property from the files on disk. The only inputs taken on
// trust are which file is the entrypoint and which file owns the defect; everything else --
// reachability, path length, branching, search discrimination, decoy reachability -- is computed.
//
// Classification is DERIVED from the measurements by declared thresholds. The thresholds are a
// judgement an independent auditor may disagree with; the measurements are not.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

// Declared thresholds. Changing these changes classifications, so they live in one place and are
// echoed into every report.
export const THRESHOLDS = {
  // Below this, the repository is too small for the investigation to be about orientation at all.
  minReachableModules: 8,
  // A defect the entrypoint reaches in fewer hops than this is a local bug, not a context test.
  minOwnerPathHops: 3,
  // A straight-line chain offers no choice; a context test needs somewhere to go wrong.
  minDecisionPoints: 2,
  // A repository whose modules are mostly unreachable is padding, not context.
  minReachableFraction: 0.35,
  // If a prompt identifier occurs in this few reachable files, grep goes straight to the owner.
  minPromptIdentifierFiles: 3,
  // Decoys must be real code the investigation can actually walk into.
  minReachableDecoys: 3,
};

const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

// An identifier in the prompt is only interesting if it looks like code rather than prose.
const CODE_IDENTIFIER = /\b(?:[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[A-Z][A-Z0-9_]{3,})\b/g;
const PROSE_IDENTIFIERS = new Set(["JavaScript", "TypeError", "RangeError", "JSON", "UTF"]);

export async function analyzeOrientation({
  repoRoot,
  entrypoint,
  defectOwner,
  decoys = [],
  prompt,
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
  const ownerHops = ownerPath === null ? null : ownerPath.length - 1;

  // Decision points: nodes on the shortest owner path that lead somewhere other than the next step
  // on that path. A chain with no alternatives has none, and an investigator following it cannot go
  // wrong -- which is what makes such a fixture a poor context test.
  const decisionPoints =
    ownerPath === null
      ? 0
      : ownerPath.slice(0, -1).filter((node, index) => {
          const next = ownerPath[index + 1];
          return (graph.get(node) ?? []).filter((edge) => edge !== next).length > 0;
        }).length;

  const identifiers = extractPromptIdentifiers(prompt ?? "");
  const identifierDiscrimination = identifiers.map((identifier) => {
    const files = [...reachable].filter((relative) => sources.get(relative)?.includes(identifier));
    return { identifier, files: files.length, ownerAmong: files.includes(defectOwner) };
  });
  // The worst case is the identifier that narrows the search most while still pointing at the owner.
  const ownerRevealing = identifierDiscrimination.filter((entry) => entry.ownerAmong);
  const searchDiscrimination =
    ownerRevealing.length === 0 ? null : Math.min(...ownerRevealing.map((entry) => entry.files));

  const decoyEvidence = decoys.map((relative) => ({
    module: relative,
    exists: modules.includes(relative),
    reachable: reachable.has(relative),
    importedBy: [...graph.entries()]
      .filter(([, edges]) => edges.includes(relative))
      .map(([node]) => node).length,
    onOwnerPath: ownerPath?.includes(relative) ?? false,
  }));

  const orphans = [...reachable].filter(
    (relative) =>
      relative !== entrypoint && [...graph.values()].every((edges) => !edges.includes(relative)),
  );
  const unreachable = modules.filter((relative) => !reachable.has(relative));

  const evidence = {
    totalModules: modules.length,
    reachableModules: reachable.size,
    reachableFraction:
      modules.length === 0 ? 0 : Number((reachable.size / modules.length).toFixed(3)),
    unreachableModules: unreachable.length,
    entrypoint,
    defectOwner,
    ownerReachable: reachable.has(defectOwner),
    shortestOwnerPath: ownerPath,
    shortestOwnerPathHops: ownerHops,
    decisionPoints,
    entrypointImportsOwner: (graph.get(entrypoint) ?? []).includes(defectOwner),
    promptIdentifiers: identifierDiscrimination,
    searchDiscrimination,
    decoys: decoyEvidence,
    reachableDecoys: decoyEvidence.filter((entry) => entry.reachable).length,
    decoysOnOwnerPath: decoyEvidence
      .filter((entry) => entry.onOwnerPath)
      .map((entry) => entry.module),
    orphanModules: orphans,
  };
  return { evidence, ...classify(evidence) };
}

// Derives a classification from measured evidence. Every reason names the measurement that produced
// it, so an auditor can re-derive the verdict or reject the threshold without re-running anything.
export function classify(evidence) {
  const disqualifying = [];
  const weakening = [];

  if (evidence.shortestOwnerPath === null) {
    disqualifying.push("the defect owner is not reachable from the entrypoint");
  }
  if (evidence.reachableModules < THRESHOLDS.minReachableModules) {
    disqualifying.push(
      `only ${evidence.reachableModules} modules are reachable (threshold ${THRESHOLDS.minReachableModules})`,
    );
  }
  if (
    evidence.shortestOwnerPathHops !== null &&
    evidence.shortestOwnerPathHops < THRESHOLDS.minOwnerPathHops
  ) {
    disqualifying.push(
      `the owner is ${evidence.shortestOwnerPathHops} hop(s) from the entrypoint (threshold ${THRESHOLDS.minOwnerPathHops})`,
    );
  }
  if (evidence.decisionPoints === 0) {
    disqualifying.push("the path to the owner is a straight line with no decision points");
  }
  if (evidence.entrypointImportsOwner) {
    disqualifying.push("the entrypoint imports the defect owner directly");
  }

  if (evidence.decisionPoints < THRESHOLDS.minDecisionPoints) {
    weakening.push(
      `only ${evidence.decisionPoints} decision point(s) on the owner path (threshold ${THRESHOLDS.minDecisionPoints})`,
    );
  }
  if (evidence.reachableFraction < THRESHOLDS.minReachableFraction) {
    weakening.push(
      `only ${(evidence.reachableFraction * 100).toFixed(1)}% of modules are reachable (threshold ${(THRESHOLDS.minReachableFraction * 100).toFixed(0)}%)`,
    );
  }
  if (
    evidence.searchDiscrimination !== null &&
    evidence.searchDiscrimination < THRESHOLDS.minPromptIdentifierFiles
  ) {
    const worst = evidence.promptIdentifiers
      .filter((entry) => entry.ownerAmong && entry.files === evidence.searchDiscrimination)
      .map((entry) => entry.identifier);
    weakening.push(
      `prompt identifier(s) ${worst.join(", ")} occur in only ${evidence.searchDiscrimination} reachable file(s), so a search reaches the owner directly (threshold ${THRESHOLDS.minPromptIdentifierFiles})`,
    );
  }
  if (evidence.reachableDecoys < THRESHOLDS.minReachableDecoys) {
    weakening.push(
      `only ${evidence.reachableDecoys} declared decoy(s) are reachable (threshold ${THRESHOLDS.minReachableDecoys})`,
    );
  }
  if (evidence.decoysOnOwnerPath.length > 0) {
    weakening.push(
      `declared decoys sit on the owner path: ${evidence.decoysOnOwnerPath.join(", ")}`,
    );
  }
  if (evidence.orphanModules.length > 0) {
    weakening.push(
      `${evidence.orphanModules.length} reachable module(s) are imported by nothing: ${evidence.orphanModules.slice(0, 4).join(", ")}`,
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

function extractPromptIdentifiers(prompt) {
  return [...new Set([...prompt.matchAll(CODE_IDENTIFIER)].map((match) => match[0]))].filter(
    (identifier) => !PROSE_IDENTIFIERS.has(identifier),
  );
}
