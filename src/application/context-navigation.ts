import { measureContextTokens, type ContextTokenMeter } from "../domain/context";
import {
  contextPageRequestKey,
  createContextHandle,
  parseContextPageRequest,
  type ContextHandle,
  type ContextNavigationLedgerEvent,
  type ContextPage,
  type ContextPageOperation,
  type ContextPageRequest,
  type ContextWorkingSet,
} from "../domain/context-navigation";
import type { ContextPageSource, RepositorySnapshot } from "../domain/ports";

export type ContextExpansionStatus = "RESOLVED" | "REUSED" | "REJECTED" | "EXHAUSTED";

export interface ContextExpansionResult {
  status: ContextExpansionStatus;
  reason: string;
  workingSet: ContextWorkingSet;
  snapshot: RepositorySnapshot;
  page?: ContextPage;
  events: ContextNavigationLedgerEvent[];
}

const operationMatches = (handle: ContextHandle, operation: ContextPageOperation): boolean => {
  if (operation === "FILE_SLICE") return handle.kind === "FILE";
  if (operation === "SYMBOL_SLICE") return handle.kind === "SYMBOL";
  if (operation === "MODULE_RELATIONSHIPS") return handle.kind === "MODULE";
  if (operation === "FIND_SYMBOL") return handle.kind === "REPOSITORY";
  if (
    operation === "FIND_DEFINITION" ||
    operation === "FIND_REFERENCES" ||
    operation === "FIND_IMPLEMENTATIONS"
  ) {
    return handle.kind === "SYMBOL";
  }
  if (operation === "KNOWLEDGE_RECORD") {
    return handle.kind === "KNOWLEDGE" || handle.kind === "EVIDENCE";
  }
  return handle.kind === "KNOWLEDGE";
};

const canonicalHandle = (handle: ContextHandle): boolean => {
  try {
    return (
      createContextHandle({
        projectId: handle.projectId,
        revision: handle.revision,
        target: handle.target,
      }).id === handle.id
    );
  } catch {
    return false;
  }
};

const clipPage = (
  content: string,
  maxCharacters: number,
): { content: string; truncated: boolean } => {
  if (content.length <= maxCharacters) return { content, truncated: false };
  const marker = "\n[Context page clipped: page character budget reached.]";
  return {
    content: `${content.slice(0, Math.max(0, maxCharacters - marker.length))}${marker}`,
    truncated: true,
  };
};

export class ContextNavigationService {
  constructor(
    private readonly source: ContextPageSource,
    private readonly tokenMeter?: ContextTokenMeter,
  ) {}

  async expand(input: {
    repositoryPath: string;
    snapshot: RepositorySnapshot;
    workingSet: ContextWorkingSet;
    request: ContextPageRequest;
    timestamp?: string;
  }): Promise<ContextExpansionResult> {
    const workingSet = structuredClone(input.workingSet);
    const events: ContextNavigationLedgerEvent[] = [];
    const timestamp = input.timestamp ?? new Date().toISOString();
    const request = parseContextPageRequest(input.request);
    if (!request) {
      const exhausted = workingSet.requestCount >= workingSet.budget.maxPageRequests;
      if (!exhausted) workingSet.requestCount += 1;
      if (exhausted) workingSet.exhaustion = "PAGE_REQUEST_LIMIT";
      const event: ContextNavigationLedgerEvent = {
        sequence: workingSet.ledger.length + 1,
        type: exhausted ? "BUDGET_EXHAUSTED" : "PAGE_REJECTED",
        timestamp,
        projectId: workingSet.projectId,
        sourceRevision: workingSet.revision,
        handleId: null,
        requestId: null,
        requestKey: null,
        operation: null,
        reason: exhausted
          ? "Mission page-request limit was exhausted."
          : "The context page request failed bounded structural validation.",
        residentCharactersBefore: workingSet.residentCharacters,
        residentCharactersAfter: workingSet.residentCharacters,
        requestCount: workingSet.requestCount,
        pageCount: workingSet.pageCount,
      };
      workingSet.ledger.push(event);
      return {
        status: exhausted ? "EXHAUSTED" : "REJECTED",
        reason: exhausted ? "PAGE_REQUEST_LIMIT" : "INVALID_REQUEST",
        workingSet,
        snapshot: input.snapshot,
        events: [event],
      };
    }
    const requestKey = contextPageRequestKey(request);
    const handle = workingSet.handles.find((candidate) => candidate.id === request.handleId);
    const event = (
      type: ContextNavigationLedgerEvent["type"],
      reason: string,
      before = workingSet.residentCharacters,
      after = workingSet.residentCharacters,
    ): void => {
      const value: ContextNavigationLedgerEvent = {
        sequence: workingSet.ledger.length + events.length + 1,
        type,
        timestamp,
        projectId: workingSet.projectId,
        sourceRevision: workingSet.revision,
        handleId: request.handleId,
        requestId: request.requestId,
        requestKey,
        operation: request.operation,
        reason,
        residentCharactersBefore: before,
        residentCharactersAfter: after,
        requestCount: workingSet.requestCount,
        pageCount: workingSet.pageCount,
      };
      events.push(value);
    };
    const finish = (
      status: ContextExpansionStatus,
      reason: string,
      snapshot = input.snapshot,
      page?: ContextPage,
    ): ContextExpansionResult => {
      workingSet.ledger.push(...events);
      return {
        status,
        reason,
        workingSet,
        snapshot,
        ...(page ? { page } : {}),
        events,
      };
    };

    if (workingSet.revision !== input.snapshot.revision) {
      event("PAGE_REJECTED", "Working Set and repository snapshot revision do not match.");
      return finish("REJECTED", "WRONG_REVISION");
    }
    if (workingSet.requestCount >= workingSet.budget.maxPageRequests) {
      workingSet.exhaustion = "PAGE_REQUEST_LIMIT";
      event("BUDGET_EXHAUSTED", "Mission page-request limit was exhausted.");
      return finish("EXHAUSTED", "PAGE_REQUEST_LIMIT");
    }

    workingSet.requestCount += 1;
    event("PAGE_REQUESTED", "A bounded context page was explicitly requested.");

    if (!handle || !canonicalHandle(handle)) {
      event("PAGE_REJECTED", "The requested handle is absent or not canonical for this mission.");
      return finish("REJECTED", "UNKNOWN_HANDLE");
    }
    if (handle.projectId !== workingSet.projectId || handle.revision !== workingSet.revision) {
      event("PAGE_REJECTED", "The handle is bound to another project or revision.");
      return finish("REJECTED", "WRONG_REVISION");
    }
    if (!operationMatches(handle, request.operation)) {
      event("PAGE_REJECTED", "The requested operation is incompatible with the handle kind.");
      return finish("REJECTED", "INVALID_OPERATION");
    }
    const existingIndex = workingSet.pages.findIndex((page) => page.requestKey === requestKey);
    const existing = existingIndex >= 0 ? workingSet.pages[existingIndex] : undefined;
    if (existing) {
      event(
        "DUPLICATE_PAGE_REQUEST",
        "Duplicate request is being revalidated against its authoritative source.",
      );
    }
    if (!existing && workingSet.pageCount >= workingSet.budget.maxPageCount) {
      workingSet.exhaustion = "PAGE_COUNT_LIMIT";
      event("BUDGET_EXHAUSTED", "Mission resident-page limit was exhausted.");
      return finish("EXHAUSTED", "PAGE_COUNT_LIMIT");
    }

    const maxCharacters = Math.min(
      request.maxCharacters ?? workingSet.budget.maxPageCharacters,
      workingSet.budget.maxPageCharacters,
    );
    let resolved: Awaited<ReturnType<ContextPageSource["resolve"]>>;
    try {
      resolved = await this.source.resolve({
        repositoryPath: input.repositoryPath,
        projectId: workingSet.projectId,
        snapshot: input.snapshot,
        handle,
        request,
        maxCharacters,
        maxItems: workingSet.budget.maxPageItems,
        ...(this.tokenMeter ? { tokenMeter: this.tokenMeter } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (existing) {
        workingSet.pages.splice(existingIndex, 1);
        workingSet.pageCount -= 1;
        workingSet.residentCharacters -= existing.measuredCharacters;
        workingSet.requestedKeys = workingSet.requestedKeys.filter((key) => key !== requestKey);
        event("PAGE_EVICTED", "The prior page was evicted because source revalidation failed.");
      }
      event("PAGE_REJECTED", `Context page source was unavailable: ${reason}`);
      return finish("REJECTED", "UNAVAILABLE");
    }
    if (resolved.result.status !== "RESOLVED" || !resolved.result.page) {
      if (existing) {
        workingSet.pages.splice(existingIndex, 1);
        workingSet.pageCount -= 1;
        workingSet.residentCharacters -= existing.measuredCharacters;
        workingSet.requestedKeys = workingSet.requestedKeys.filter((key) => key !== requestKey);
        event("PAGE_EVICTED", "The prior page was evicted because it could not be revalidated.");
      }
      event(
        resolved.result.status === "STALE" ? "STALE_PAGE_REJECTED" : "PAGE_REJECTED",
        resolved.result.reason,
      );
      return finish(
        "REJECTED",
        resolved.result.status === "STALE" ? "STALE" : resolved.result.status,
        resolved.snapshot,
      );
    }

    const clipped = clipPage(resolved.result.page.content, maxCharacters);
    const relatedHandles = resolved.result.page.relatedHandles
      .filter(
        (candidate) =>
          candidate.projectId === workingSet.projectId &&
          candidate.revision === workingSet.revision &&
          canonicalHandle(candidate),
      )
      .slice(0, workingSet.budget.maxPageItems);
    const tokenMeasurement = measureContextTokens(clipped.content, this.tokenMeter);
    const page: ContextPage = {
      ...resolved.result.page,
      requestKey,
      handle,
      content: clipped.content,
      relatedHandles,
      measuredCharacters: clipped.content.length,
      tokenMeasurement,
      truncated: resolved.result.page.truncated || clipped.truncated,
      freshness: "CURRENT",
      completeness: "BOUNDED_OBSERVATION",
      authority: "CONTEXT_ONLY",
    };
    const residentAfter =
      workingSet.residentCharacters - (existing?.measuredCharacters ?? 0) + page.measuredCharacters;
    if (residentAfter > workingSet.budget.maxTextCharacters) {
      workingSet.exhaustion = "RESIDENT_CHARACTER_BUDGET";
      event(
        "BUDGET_EXHAUSTED",
        "Resolved page would exceed the total resident-context character budget.",
      );
      return finish("EXHAUSTED", "RESIDENT_CHARACTER_BUDGET", resolved.snapshot);
    }

    const residentBefore = workingSet.residentCharacters;
    if (existing) workingSet.pages[existingIndex] = page;
    else {
      workingSet.pages.push(page);
      workingSet.pageCount += 1;
      workingSet.requestedKeys.push(requestKey);
    }
    workingSet.residentCharacters = residentAfter;
    workingSet.handles = [
      ...new Map(
        [...workingSet.handles, ...relatedHandles].map((candidate) => [candidate.id, candidate]),
      ).values(),
    ].slice(0, workingSet.budget.maxContextHandles);
    workingSet.exhaustion = null;
    if (
      existing &&
      existing.content === page.content &&
      existing.source === page.source &&
      existing.truncated === page.truncated &&
      JSON.stringify(existing.relatedHandles) === JSON.stringify(page.relatedHandles)
    ) {
      event(
        "CONTEXT_REUSED",
        "The source revalidated the unchanged page; no duplicate resident page was created.",
        residentBefore,
        residentAfter,
      );
      return finish("REUSED", "REVALIDATED_UNCHANGED", resolved.snapshot, page);
    }
    event(
      "PAGE_RESOLVED",
      existing
        ? "The source returned changed material and the prior resident page was replaced."
        : page.truncated
          ? "A bounded context page was resolved with explicit clipping."
          : "A bounded context page was resolved and admitted to the Working Set.",
      residentBefore,
      residentAfter,
    );
    return finish(
      "RESOLVED",
      existing ? "REVALIDATED_CHANGED" : page.truncated ? "RESOLVED_TRUNCATED" : "RESOLVED",
      resolved.snapshot,
      page,
    );
  }
}
