// Lexical leakage validation for materialized candidate workspaces.
//
// SCOPE AND LIMITS. This module performs filename-token matching and file-content phrase matching
// against a declared vocabulary (evaluation/curator/leakage-policy.json). It is lexical only. It
// cannot detect a private artifact that has been renamed to a neutral filename and paraphrased
// around the vocabulary, and it makes no semantic judgement about whether a comment gives the
// answer away. Reports must describe its result as lexical validation, never as a guarantee that a
// workspace is free of leakage.
//
// The independent audit of snapshot bb326527 found the previous detector missed src/answer.mjs,
// src/expected-patch.mjs and content such as "the correct fix is ...", because its vocabulary was a
// nine-word list matched only on delimiter boundaries.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const policyPath = path.join(
  path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  "curator",
  "leakage-policy.json",
);

const MAX_SCANNED_BYTES = 1_000_000;
let cachedPolicy;

export async function loadLeakagePolicy() {
  cachedPolicy ??= compilePolicy(JSON.parse(await readFile(policyPath, "utf8")));
  return cachedPolicy;
}

function compilePolicy(raw) {
  return {
    ...raw,
    pathTerms: new Set(raw.pathTerms.map((term) => term.toLowerCase())),
    pathPhrases: raw.pathPhrases.map((phrase) => phrase.toLowerCase().split(/\s+/)),
    contentPhrases: raw.contentPhrases.map((phrase) => ({
      phrase,
      // Separators between words are flexible so "expected-patch", "expected_patch" and
      // "expected  patch" all match the same declared phrase.
      pattern: new RegExp(phrase.toLowerCase().split(/\s+/).map(escapeRegExp).join("[\\s._-]+"), "i"),
    })),
    allowedPaths: new Set(Object.keys(raw.allowedPaths ?? {})),
    taskForbiddenStrings: raw.taskForbiddenStrings ?? {},
  };
}

// Splits a repository-relative path into lowercase tokens across directory separators, dots,
// dashes, underscores and camelCase boundaries, so `src/expectedPatch.mjs` and
// `src/expected-patch.mjs` tokenize identically.
export function tokenizePath(relativePath) {
  return relativePath
    .replaceAll("\\", "/")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[/.\-_\s]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
}

export function inspectPath(relativePath, policy) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (policy.allowedPaths.has(normalized)) return null;
  const tokens = tokenizePath(normalized);
  for (const token of tokens) {
    if (policy.pathTerms.has(token)) return `term "${token}"`;
  }
  for (const phrase of policy.pathPhrases) {
    for (let index = 0; index + phrase.length <= tokens.length; index += 1) {
      if (phrase.every((word, offset) => tokens[index + offset] === word)) {
        return `phrase "${phrase.join(" ")}"`;
      }
    }
  }
  return null;
}

export function inspectContent(content, policy, taskId) {
  for (const { phrase, pattern } of policy.contentPhrases) {
    if (pattern.test(content)) return `phrase "${phrase}"`;
  }
  for (const forbidden of policy.taskForbiddenStrings[taskId] ?? []) {
    if (content.toLowerCase().includes(forbidden.toLowerCase())) {
      return `task-specific string "${forbidden}"`;
    }
  }
  return null;
}

// Returns a list of human-readable leak descriptions. An empty list means "no lexical leak was
// found", not "there is no leak".
export async function findPrivateLeakage(workspace, options = {}) {
  const { taskId } = typeof options === "string" ? { taskId: options } : options;
  const policy = await loadLeakagePolicy();
  const leaks = [];
  for (const entry of await readdir(workspace, { recursive: true })) {
    const relative = String(entry);
    const pathReason = inspectPath(relative, policy);
    if (pathReason) leaks.push(`path:${relative} (${pathReason})`);
    const absolute = path.join(workspace, relative);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size > MAX_SCANNED_BYTES) continue;
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null) continue;
    const contentReason = inspectContent(content, policy, taskId);
    if (contentReason) leaks.push(`content:${relative} (${contentReason})`);
  }
  return leaks;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
