/**
 * Shared deterministic helpers for turning agent/diff activity into repository-relative file
 * paths that actually exist in the repository. Used by both the runtime-signal collector (to
 * decide what counts as observed scope) and the run service (to decide what to incrementally
 * scope-index), so the two always agree on what a "touched file" is.
 */

export const normalizeFile = (value: string): string =>
  value
    .replace(/^file:\/\//u, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "");

export const findRepositoryFile = (candidate: string, files: Set<string>): string | undefined => {
  const normalized = normalizeFile(candidate);
  if (files.has(normalized)) return normalized;
  return [...files].find((file) => normalized.endsWith(`/${file}`));
};

export const extractFileCandidates = (
  value: unknown,
  key = "",
  output = new Set<string>(),
): string[] => {
  if (typeof value === "string" && /(file|path|target|uri)/iu.test(key)) output.add(value);
  if (Array.isArray(value) && /(file|path|target|uri)/iu.test(key)) {
    for (const child of value) if (typeof child === "string") output.add(child);
  } else if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value))
      extractFileCandidates(child, childKey, output);
  }
  return [...output];
};
