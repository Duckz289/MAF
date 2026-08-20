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
  /** Git reported a binary patch body that line-oriented security checkers cannot inspect. */
  binary: boolean;
  /** Other Git change forms whose destination bytes are not present in the textual patch. */
  uninspectableReasons?: Array<"BINARY" | "GITLINK" | "RENAME_OR_COPY">;
}

const stripPrefix = (path: string): string => path.replace(/^(?:a|b)\//u, "").replace(/\\/g, "/");

// A real git header path is quoted, /dev/null, or a/- or b/-prefixed. Requiring that shape keeps
// source content from impersonating a header: an added line whose text begins with "++ " produces
// the diff line "+++ ++ ..." only when the content itself starts with "++", and plain prose never
// carries the a/ or b/ prefix.
const QUOTED_GIT_PATH = String.raw`"((?:\\.|[^"])*)"`;
const PLUS_HEADER = new RegExp(
  String.raw`^\+\+\+\s+(?:${QUOTED_GIT_PATH}|\/dev\/null|((?:a|b)\/\S+))`,
  "u",
);
const MINUS_HEADER = new RegExp(
  String.raw`^---\s+(?:${QUOTED_GIT_PATH}|\/dev\/null|((?:a|b)\/\S+))`,
  "u",
);
const DIFF_HEADER = new RegExp(
  String.raw`^diff --git (?:${QUOTED_GIT_PATH}|(a\/\S+)) (?:${QUOTED_GIT_PATH}|(b\/\S+))$`,
  "u",
);

/** Decodes the C-style quoting Git uses when core.quotePath is enabled. */
export const decodeGitPath = (value: string): string => {
  const known: Record<string, string> = {
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
    "\\": "\\",
    '"': '"',
  };
  let decoded = "";
  for (let index = 0; index < value.length; ) {
    if (value[index] !== "\\") {
      decoded += value[index];
      index += 1;
      continue;
    }
    const bytes: number[] = [];
    let cursor = index;
    while (value[cursor] === "\\") {
      const octal = value.slice(cursor + 1).match(/^[0-7]{1,3}/u)?.[0];
      if (!octal) break;
      bytes.push(Number.parseInt(octal, 8));
      cursor += octal.length + 1;
    }
    if (bytes.length > 0) {
      decoded += new TextDecoder().decode(Uint8Array.from(bytes));
      index = cursor;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      decoded += "\\";
      index += 1;
    } else {
      decoded += known[escaped] ?? escaped;
      index += 2;
    }
  }
  return decoded;
};

const headerPath = (match: RegExpMatchArray | null): string | undefined => {
  if (!match) return undefined;
  const file = stripPrefix(decodeGitPath(match[1] ?? match[2] ?? ""));
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
  let diffFile: string | undefined;
  let pendingUninspectable = new Set<"BINARY" | "GITLINK" | "RENAME_OR_COPY">();
  const ensureCurrent = (): FilePatch | undefined => {
    if (!current && diffFile) {
      current = { file: diffFile, addedLines: [], removedLines: [], binary: false };
      files.push(current);
    }
    return current;
  };
  const markUninspectable = (reason: "BINARY" | "GITLINK" | "RENAME_OR_COPY"): void => {
    pendingUninspectable.add(reason);
    const entry = ensureCurrent();
    if (!entry) return;
    entry.uninspectableReasons = [...new Set([...(entry.uninspectableReasons ?? []), reason])];
    if (reason === "BINARY") entry.binary = true;
  };
  for (const rawLine of patch.split(/\r?\n/u)) {
    const diffMatch = rawLine.match(DIFF_HEADER);
    if (diffMatch) {
      diffFile = stripPrefix(
        decodeGitPath(diffMatch[3] ?? diffMatch[4] ?? diffMatch[1] ?? diffMatch[2] ?? ""),
      );
      current = undefined;
      minusFile = undefined;
      pendingUninspectable = new Set();
      continue;
    }
    if (
      /^(?:new file mode|deleted file mode|old mode|new mode) 160000$/u.test(rawLine) ||
      /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/iu.test(rawLine)
    ) {
      markUninspectable("GITLINK");
      continue;
    }
    if (/^(?:rename|copy) (?:from|to) /u.test(rawLine)) {
      markUninspectable("RENAME_OR_COPY");
      continue;
    }
    const plusMatch = rawLine.match(PLUS_HEADER);
    if (plusMatch) {
      // Deletion: "+++ /dev/null" but the "--- a/<file>" header names what was deleted.
      const plusFile = headerPath(plusMatch);
      const file = plusFile ?? minusFile;
      if (!file) current = undefined;
      else if (!current || current.file !== file) {
        current = { file, addedLines: [], removedLines: [], binary: false };
        files.push(current);
      }
      if (current && pendingUninspectable.size > 0) {
        current.uninspectableReasons = [...pendingUninspectable];
        current.binary = pendingUninspectable.has("BINARY");
      }
      continue;
    }
    const minusMatch = rawLine.match(MINUS_HEADER);
    if (minusMatch) {
      // The "--- a/<file>" header precedes its "+++" partner; it must not be counted as a removed
      // line of whatever file was current before it.
      minusFile = headerPath(minusMatch);
      continue;
    }
    if (rawLine === "GIT binary patch" || /^Binary files .+ differ$/u.test(rawLine)) {
      markUninspectable("BINARY");
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("+")) current.addedLines.push(rawLine.slice(1));
    else if (rawLine.startsWith("-")) current.removedLines.push(rawLine.slice(1));
  }
  return files;
};
