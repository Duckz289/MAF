import type { ContextBuilderPort, ContextRequest, ProjectBrain } from "../domain/ports";

const clip = (value: string, length: number): string =>
  value.length <= length ? value : `${value.slice(0, length - 3)}...`;

export class GuidedContextBuilder implements ContextBuilderPort {
  constructor(private readonly brain: ProjectBrain) {}

  async build(request: ContextRequest): Promise<{
    text: string;
    evidenceIds: string[];
    tokenEstimate: number;
  }> {
    if (request.mode === "SOLO_NATIVE") {
      const text = [
        `Goal: ${request.task.prompt}`,
        `Revision: ${request.task.revision}`,
        "Native repository search and planning remain fully available.",
      ].join("\n");
      return { text, evidenceIds: [], tokenEstimate: Math.ceil(text.length / 4) };
    }

    const knowledge = await this.brain.list(request.projectId, request.task.revision, [
      "FACT",
      "DECISION",
      "EVIDENCE",
    ]);
    const modules = Object.entries(request.snapshot.moduleMap)
      .slice(0, request.mode === "STRICT" ? 4 : 12)
      .map(([name, files]) => `${name}: ${files.slice(0, 8).join(", ")}`);
    const symbols = request.snapshot.symbols
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
    };
  }
}
