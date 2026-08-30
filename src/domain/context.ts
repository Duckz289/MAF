import type { ExecutionMode } from "./types";

/**
 * An architectural context allowance, deliberately smaller than any provider/model window. The
 * current builder uses deterministic cardinality and character ceilings; a future tokenizer can
 * replace the labelled heuristic without changing the budget or ledger contracts.
 */
export interface ContextBudget {
  maxTextCharacters: number;
  maxGoalCharacters: number;
  maxModules: number;
  maxStrictModules: number;
  maxFilesPerModule: number;
  maxSymbols: number;
  maxStrictSymbols: number;
  maxKnowledgeRecords: number;
  maxKnowledgeItems: number;
  maxEvidenceReferences: number;
  maxItemCharacters: number;
  maxLedgerItemsPerCategory: number;
  /** Total page requests, including rejected and duplicate requests, allowed for one mission. */
  maxPageRequests: number;
  /** Successfully resolved hot pages allowed to become resident for one mission. */
  maxPageCount: number;
  /** Per-page content ceiling before the total resident-context ceiling is considered. */
  maxPageCharacters: number;
  /** Maximum records/relations/handles returned by one page operation. */
  maxPageItems: number;
  /** Locator ceiling; handles are cheap references but are still bounded mission context. */
  maxContextHandles: number;
}

export const DEFAULT_CONTEXT_BUDGET: Readonly<ContextBudget> = Object.freeze({
  maxTextCharacters: 24_000,
  maxGoalCharacters: 2_000,
  maxModules: 4,
  maxStrictModules: 2,
  maxFilesPerModule: 8,
  maxSymbols: 60,
  maxStrictSymbols: 20,
  maxKnowledgeRecords: 60,
  maxKnowledgeItems: 30,
  maxEvidenceReferences: 64,
  maxItemCharacters: 240,
  maxLedgerItemsPerCategory: 32,
  maxPageRequests: 16,
  maxPageCount: 8,
  maxPageCharacters: 4_000,
  maxPageItems: 32,
  maxContextHandles: 64,
});

export type ContextBuildStage =
  | "INITIAL_SCOPE"
  | "INITIAL_RENDER"
  | "MODE_REBUILD_SCOPE"
  | "MODE_REBUILD_RENDER";

export interface ContextModuleSelection {
  name: string;
  files: string[];
  score: number;
}

/**
 * The existing select-then-parse pager made explicit. A rendered context can reuse this selection
 * after indexScope enriches the snapshot, so it does not rank the whole module map a second time.
 */
export interface ContextSelection {
  mode: ExecutionMode;
  sourceRevision: string;
  modules: ContextModuleSelection[];
  initialFiles: string[];
  initialModules: string[];
  scannedModules: number;
  scannedFiles: number;
  matchedModules: number;
  truncated: boolean;
}

export type ContextLedgerCategory =
  | "ORIENTATION"
  | "MODULES"
  | "FILES"
  | "SYMBOLS"
  | "KNOWLEDGE"
  | "EVIDENCE_REFERENCES"
  | "HANDLES"
  | "RENDERED_CONTEXT";

export type ContextFreshness = "CURRENT" | "STALE" | "UNKNOWN" | "NOT_APPLICABLE";
export type TokenEstimateBasis = "CHARACTERS_DIVIDED_BY_4" | "EXACT_TOKENIZER" | "UNKNOWN";

export type ContextTokenMeasurement =
  | {
      value: number;
      precision: "EXACT";
      method: string;
    }
  | {
      value: number;
      precision: "ESTIMATED";
      method: "CHARACTERS_DIVIDED_BY_4";
    }
  | {
      value: null;
      precision: "UNKNOWN";
      method: null;
    };

/** Optional exact counter seam. Returning null falls back to the labelled character heuristic. */
export interface ContextTokenMeter {
  readonly name: string;
  count(text: string): number | null;
}

export const measureContextTokens = (
  text: string,
  meter?: ContextTokenMeter,
): ContextTokenMeasurement => {
  if (meter) {
    const counted = meter.count(text);
    if (counted !== null) {
      if (!Number.isInteger(counted) || counted < 0) {
        throw new Error(`Context token meter ${meter.name} returned an invalid count`);
      }
      return { value: counted, precision: "EXACT", method: meter.name };
    }
  }
  return {
    value: Math.ceil(text.length / 4),
    precision: "ESTIMATED",
    method: "CHARACTERS_DIVIDED_BY_4",
  };
};

export interface ContextLedgerEntry {
  category: ContextLedgerCategory;
  source: "TASK" | "REPOSITORY_INDEX" | "PROJECT_BRAIN" | "CONTEXT_POLICY";
  reason: string;
  sourceRevision: string;
  selectedItems: string[];
  selectedItemCount: number;
  /** Null means the source cardinality was not measured exactly, never an inferred zero. */
  availableItemCount: number | null;
  measuredCharacters: number | null;
  estimatedTokens: number | null;
  tokenEstimateBasis: TokenEstimateBasis;
  truncated: boolean;
  freshness: ContextFreshness;
}

/** Factual context-construction state, persisted as an ordinary run event by RunService. */
export interface ContextLedger {
  missionId: string;
  runId: string | null;
  projectId: string;
  buildStage: ContextBuildStage;
  sourceRevision: string;
  mode: ExecutionMode;
  budget: ContextBudget;
  entries: ContextLedgerEntry[];
  measuredCharacters: number;
  estimatedTokens: number;
  tokenEstimateBasis: Exclude<TokenEstimateBasis, "UNKNOWN">;
  tokenMeasurement: ContextTokenMeasurement;
  truncated: boolean;
  truncationReasons: string[];
  createdAt: string;
}
