/**
 * Minimal deterministic unified-diff parser shared by the M7 governance checkers (debt delta,
 * architecture layering). Parses only what those checkers need: per-file added and removed lines.
 * Deliberately not a general-purpose diff library — hunk headers and metadata are skipped, and
 * anything that is not an added/removed line is ignored, so a malformed patch degrades to "no
 * evidence from this line" rather than an error.
 */

export interface FilePatch {
  /** Repository-relative path with any a//b/ prefix already stripped. */
  file: string;
  addedLines: string[];
  removedLines: string[];
}

const stripPrefix = (path: string): string => path.replace(/^(?:a|b)\//u, "").replace(/\\/g, "/");

// A real git header path is quoted, /dev/null, or a/- or b/-prefixed. Requiring that shape keeps
// source content from impersonating a header: an added line whose text begins with "++ " produces
// the diff line "+++ ++ ..." only when the content itself starts with "++", and plain prose never
// carries the a/ or b/ prefix.
const PLUS_HEADER = /^\+\+\+\s+(?:"([^"]+)"|\/dev\/null|(?:a|b)\/(\S+))/u;
const MINUS_HEADER = /^---\s+(?:"([^"]+)"|\/dev\/null|(?:a|b)\/(\S+))/u;

const headerPath = (match: RegExpMatchArray | null): string | undefined => {
  if (!match) return undefined;
  const file = stripPrefix(match[1] ?? match[2] ?? "");
  return file && file !== "/dev/null" ? file : undefined;
};

/**
 * Parses a unified diff into per-file added/removed lines. Binary files, rename/copy headers, and
 * mode-change entries contribute no lines; a file whose patch body is absent simply has empty
 * arrays. A deleted file ("+++ /dev/null") keeps its entry — attributed via the preceding
 * "--- a/<file>" header — so its removed lines still count (a deleted file's debt markers ARE
 * removed debt). The same patch always parses to the same result.
 */
export const parseFilePatches = (patch: string): FilePatch[] => {
  const files: FilePatch[] = [];
  let current: FilePatch | undefined;
  let minusFile: string | undefined;
  for (const rawLine of patch.split(/\r?\n/u)) {
    const plusMatch = rawLine.match(PLUS_HEADER);
    if (plusMatch) {
      // Deletion: "+++ /dev/null" but the "--- a/<file>" header names what was deleted.
      const plusFile = headerPath(plusMatch);
      const file = plusFile ?? minusFile;
      current = file ? { file, addedLines: [], removedLines: [] } : undefined;
      if (current) files.push(current);
      continue;
    }
    const minusMatch = rawLine.match(MINUS_HEADER);
    if (minusMatch) {
      // The "--- a/<file>" header precedes its "+++" partner; it must not be counted as a removed
      // line of whatever file was current before it.
      minusFile = headerPath(minusMatch);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("+")) current.addedLines.push(rawLine.slice(1));
    else if (rawLine.startsWith("-")) current.removedLines.push(rawLine.slice(1));
  }
  return files;
};
