import { parseFilePatches } from "./diff-parse";

/**
 * M7A debt-delta checker. Debt here means explicitly self-declared technical debt: TODO/FIXME/
 * HACK/XXX markers a change adds or removes in source files. This is deliberately narrow and
 * deterministic — it measures what the diff itself proves, never a model's opinion of "code
 * quality". A change that adds debt markers increases declared debt; one that removes them pays it
 * down; markers in non-source files (docs, fixtures output) don't count because they don't ship.
 */

export type DebtCheckState = "PASS" | "WARN" | "FAIL";

export interface DebtDeltaResult {
  state: DebtCheckState;
  evidence: string[];
  /** Markers added/removed across source files in the diff — the raw signal behind the state. */
  addedMarkers: number;
  removedMarkers: number;
}

const sourceFilePattern = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
/** Word-bounded so "TODO" matches but "TODOS" or "autodoc" does not. */
const debtMarkerPattern = /\b(?:TODO|FIXME|HACK|XXX)\b/gu;

const countMarkers = (lines: string[]): number =>
  lines.reduce((sum, line) => sum + (line.match(debtMarkerPattern)?.length ?? 0), 0);

/** A single WARN-worthy net increase; gating thresholds live in the risk vector (DebtRisk). */
export const DEBT_FAIL_THRESHOLD = 5;

/**
 * Derives the diff's declared-debt delta. net > 0 is a WARN (debt added); net >= 5 is a FAIL (a
 * change that declares five or more new debt markers in one diff is not debt, it is a rewrite
 * deferral); net <= 0 is a PASS — flat diffs and debt paydown both count as no debt added.
 */
export const deriveDebtDelta = (patch: string): DebtDeltaResult => {
  const sourcePatches = parseFilePatches(patch).filter((entry) =>
    sourceFilePattern.test(entry.file),
  );
  const addedMarkers = sourcePatches.reduce(
    (sum, entry) => sum + countMarkers(entry.addedLines),
    0,
  );
  const removedMarkers = sourcePatches.reduce(
    (sum, entry) => sum + countMarkers(entry.removedLines),
    0,
  );
  const net = addedMarkers - removedMarkers;
  const evidence =
    sourcePatches.length === 0
      ? ["no source files changed, so no declared-debt delta can exist"]
      : [
          `${addedMarkers} debt marker(s) added and ${removedMarkers} removed across ${sourcePatches.length} changed source file(s) (net ${net >= 0 ? "+" : ""}${net})`,
        ];
  if (net >= DEBT_FAIL_THRESHOLD) {
    return {
      state: "FAIL",
      evidence: [...evidence, "net increase meets the FAIL threshold"],
      addedMarkers,
      removedMarkers,
    };
  }
  if (net > 0) {
    return { state: "WARN", evidence, addedMarkers, removedMarkers };
  }
  return { state: "PASS", evidence, addedMarkers, removedMarkers };
};
