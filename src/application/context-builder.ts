import type {
  ContextBuilderPort,
  ContextBuildResult,
  ContextRequest,
  ProjectBrain,
} from "../domain/ports";

const clip = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length - 3)}...`;

export class GuidedContextBuilder implements ContextBuilderPort {
  constructor(private readonly brain: ProjectBrain) {}

  async build(request: ContextRequest): Promise<ContextBuildResult> {
    if (request.mode === "SOLO_NATIVE") {
      const text = [
        `Goal: ${request.task.prompt}`,
        `Revision: ${request.task.revision}`,
        "Native repository search and planning remain fully available.",
      ].join("\n");
      return {
        text,
        evidenceIds: [],
        tokenEstimate: Math.ceil(text.length / 4),
        initialFiles: [],
        initialModules: [],
      };
    }

    const knowledge = await this.brain.list(request.projectId, request.task.revision, [
      "FACT",
      "DECISION",
      "EVIDENCE",
    ]);
    const taskTerms = new Set(
      request.task.prompt
        .toLowerCase()
        .split(/[^a-z0-9_$-]+/u)
        .filter((term) => term.length >= 3),
    );
    const rankedModules = Object.entries(request.snapshot.moduleMap)
      .map(([name, files]) => ({
        name,
        files,
        score: [...taskTerms].reduce(
          (score, term) =>
            score +
            (name.toLowerCase().includes(term) ? 4 : 0) +
            files.filter((file) => file.toLowerCase().includes(term)).length,
          0,
        ),
      }))
      .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
    const relevantModules = rankedModules.filter((module) => module.score > 0);
    const selectedModules = (
      relevantModules.length > 0
        ? relevantModules
        : rankedModules.slice(0, request.mode === "STRICT" ? 2 : 4)
    ).slice(0, request.mode === "STRICT" ? 2 : 4);
    const initialFiles = selectedModules.flatMap((module) => module.files.slice(0, 8));
    const initialFileSet = new Set(initialFiles);
    const modules = selectedModules.map(
      ({ name, files }) => `${name}: ${files.slice(0, 8).join(", ")}`,
    );
    const symbols = request.snapshot.symbols
      .filter((symbol) => initialFileSet.has(symbol.file))
      .slice(0, request.mode === "STRICT" ? 20 : 60)
      .map((symbol) => `${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`);
    const facts = knowledge
      .filter((record) => record.kind === "FACT" || record.kind === "DECISION")
      .slice(0, 30)
      .map((record) => `${record.kind}: ${clip(record.statement, 240)}`);
    const text = [
      `Goal: ${request.task.prompt}`,
      `Mode: ${request.mode}`,
      `Revision: ${request.task.revision}`,
      "This context is a verified starting point. Native repository search remains available.",
      "Modules:",
      ...modules,
      "Relevant symbols:",
      ...symbols,
      "Verified knowledge:",
      ...(facts.length > 0 ? facts : ["No verified facts recorded for this revision."]),
    ].join("\n");
    return {
      text,
      evidenceIds: knowledge.flatMap((record) => record.evidenceIds),
      tokenEstimate: Math.ceil(text.length / 4),
      initialFiles,
      initialModules: selectedModules.map((module) => module.name),
    };
  }
}
