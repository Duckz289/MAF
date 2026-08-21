import { parseFilePatches } from "./diff-parse";

/** Evidence-backed deployment topology. This is deliberately separate from the source Project Graph. */
export type RuntimeNodeKind =
  | "BROWSER"
  | "APPLICATION"
  | "API"
  | "DATABASE"
  | "CACHE"
  | "STORAGE"
  | "SERVICE"
  | "EXTERNAL_SERVICE";

export interface RuntimeNode {
  id: string;
  kind: RuntimeNodeKind;
  label: string;
  evidence: string[];
}

export interface RuntimeEdgeAttributes {
  networkBoundary: boolean | null;
  timeoutMs: number | null;
  retryPolicy: string | null;
  authenticationBoundary: string | null;
  rateLimiting: string | null;
  payloadBehavior: string | null;
  consistencyAssumption: string | null;
}

export interface RuntimeEdge {
  from: string;
  to: string;
  kind: "CALLS" | "READS_WRITES" | "CACHES" | "STORES";
  attributes: RuntimeEdgeAttributes;
  evidence: string[];
}

export interface RuntimeGraph {
  nodes: RuntimeNode[];
  edges: RuntimeEdge[];
  unknowns: string[];
}

const pathMatches = (file: string, pattern: RegExp): boolean => pattern.test(file);
const browserPath = /(^|\/)(?:web|frontend|client)(?:\/|$)|\.[jt]sx$/iu;
const apiPath = /(^|\/)(?:api|server|routes?)(?:\/|$)/iu;
const runtimeCodePath = /\.(?:[cm]?[jt]sx?|go|py|java|cs|rb|rs|php)$/iu;
const nonDeploymentPath =
  /(^|\/)(?:tests?|__tests__|fixtures?|scripts?|tools?|benchmarks?)(\/|$)|\.(?:test|spec)\.[^/]+$/iu;
// Content-only signals: filenames and generic identifiers (e.g. a local `cache` Map, `fs.writeFile`,
// the word "database" in a variable name) do not evidence deployment topology, so they must not
// create nodes. SQL statement shapes and named infrastructure technologies do.
const databaseSignal =
  /\bselect\b.+\bfrom\b|\binsert\s+into\b|\bupdate\s+[\w."`-]+\s+set\b|\bdelete\s+from\b|prisma\.|sequelize|typeorm/iu;
const cacheSignal = /\b(?:redis|memcached)\b/iu;
const storageSignal = /\b(?:s3|object storage)\b/iu;
const externalSignal = /\bfetch\s*\(|\baxios\b|external api/iu;
const explicitExternalSignal = /\bexternal api\b/iu;

const edgeAttributes = (
  lines: string[],
  networkBoundary: boolean | null,
): RuntimeEdgeAttributes => {
  const joined = lines.join("\n");
  const timeouts = [
    ...new Set(
      [...joined.matchAll(/\btimeout(?:Ms)?\s*[:=]\s*(\d{2,7})\b/giu)].map((match) => match[1]),
    ),
  ];
  return {
    networkBoundary,
    timeoutMs: timeouts.length === 1 ? Number(timeouts[0]) : null,
    retryPolicy: /\bretr(?:y|ies)\b/iu.test(joined)
      ? "retry behavior present; exact policy unknown"
      : null,
    authenticationBoundary: /authorization|bearer|credential|oauth/iu.test(joined)
      ? "authentication material or boundary referenced"
      : null,
    rateLimiting: /rate.?limit|\b429\b/iu.test(joined) ? "rate-limit behavior referenced" : null,
    payloadBehavior: /pagination|cursor|\blimit\b|JSON\.stringify|buffer|stream/iu.test(joined)
      ? "payload sizing/streaming behavior referenced"
      : null,
    consistencyAssumption: /transaction|serializable|eventual|optimistic|lock/iu.test(joined)
      ? "consistency/concurrency behavior referenced"
      : null,
  };
};

/**
 * Builds only topology directly evidenced by changed paths and added code. Co-change alone never
 * creates an edge: an edge requires dependency-shaped text in a file associated with its source
 * runtime component. Unknown attributes stay null and are summarized explicitly.
 */
export const deriveRuntimeGraph = (patch: string): RuntimeGraph => {
  const parsed = parseFilePatches(patch);
  const nodes = new Map<string, RuntimeNode>();
  const edges: RuntimeEdge[] = [];
  const edgeLines = new Map<string, string[]>();
  const addNode = (kind: RuntimeNodeKind, evidence: string): RuntimeNode => {
    const id = kind.toLowerCase().replace(/_/gu, "-");
    const existing = nodes.get(id);
    if (existing) {
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
      return existing;
    }
    const node = { id, kind, label: kind.replace(/_/gu, " "), evidence: [evidence] };
    nodes.set(id, node);
    return node;
  };
  const addEdge = (
    from: RuntimeNode,
    to: RuntimeNode,
    kind: RuntimeEdge["kind"],
    file: string,
    lines: string[],
    networkBoundary: boolean | null,
  ): void => {
    const key = `${from.id}:${kind}:${to.id}`;
    const existing = edges.find(
      (edge) => edge.from === from.id && edge.to === to.id && edge.kind === kind,
    );
    if (existing) {
      const combinedLines = [...(edgeLines.get(key) ?? []), ...lines];
      edgeLines.set(key, combinedLines);
      existing.attributes = edgeAttributes(combinedLines, networkBoundary);
      const evidence = `${file}: added code references this runtime relationship`;
      if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
      return;
    }
    edgeLines.set(key, [...lines]);
    edges.push({
      from: from.id,
      to: to.id,
      kind,
      attributes: edgeAttributes(lines, networkBoundary),
      evidence: [`${file}: added code references this runtime relationship`],
    });
  };

  for (const entry of parsed) {
    const lines = entry.addedLines.filter((line) => !/^\s*(?:\/\/|\/\*|\*|#|<!--)/u.test(line));
    const joined = lines.join("\n");
    const isDeploymentPath = !pathMatches(entry.file, nonDeploymentPath);
    const isRuntimeCode = pathMatches(entry.file, runtimeCodePath) && isDeploymentPath;
    const isBrowser = isRuntimeCode && pathMatches(entry.file, browserPath);
    const isApi = isRuntimeCode && pathMatches(entry.file, apiPath);
    const source = !isRuntimeCode
      ? undefined
      : isBrowser
        ? addNode("BROWSER", `${entry.file}: browser/frontend runtime code`)
        : isApi
          ? addNode("API", `${entry.file}: API/server runtime code`)
          : addNode("APPLICATION", `${entry.file}: application runtime code`);

    if (
      (isRuntimeCode && databaseSignal.test(joined)) ||
      (isDeploymentPath && /(^|\/)(?:migrations?)(?:\/|$)|\.sql$|\.prisma$/iu.test(entry.file))
    ) {
      const database = addNode("DATABASE", `${entry.file}: database/query evidence`);
      if (source)
        addEdge(
          source,
          database,
          "READS_WRITES",
          entry.file,
          lines.filter((line) => databaseSignal.test(line)),
          null,
        );
    }
    if (isRuntimeCode && cacheSignal.test(joined)) {
      const cache = addNode("CACHE", `${entry.file}: cache evidence`);
      if (source)
        addEdge(
          source,
          cache,
          "CACHES",
          entry.file,
          lines.filter((line) => cacheSignal.test(line)),
          null,
        );
    }
    if (isRuntimeCode && storageSignal.test(joined)) {
      const storage = addNode("STORAGE", `${entry.file}: storage evidence`);
      if (source)
        addEdge(
          source,
          storage,
          "STORES",
          entry.file,
          lines.filter((line) => storageSignal.test(line)),
          null,
        );
    }
    if (isRuntimeCode && source && externalSignal.test(joined)) {
      const externalLines = lines.filter((line) => externalSignal.test(line));
      if (isBrowser && externalLines.some((line) => /\/api\b|api\./iu.test(line))) {
        const api = addNode("API", `${entry.file}: browser code calls an API`);
        addEdge(source, api, "CALLS", entry.file, externalLines, true);
      } else if (externalLines.some((line) => explicitExternalSignal.test(line))) {
        const external = addNode(
          "EXTERNAL_SERVICE",
          `${entry.file}: code explicitly identifies an external API`,
        );
        addEdge(source, external, "CALLS", entry.file, externalLines, true);
      } else {
        const service = addNode(
          "SERVICE",
          `${entry.file}: network service call; ownership is not evidenced`,
        );
        addEdge(source, service, "CALLS", entry.file, externalLines, true);
      }
    }
  }

  const unknowns = edges.flatMap((edge) =>
    Object.entries(edge.attributes)
      .filter(([, value]) => value === null)
      .map(([attribute]) => `${edge.from}->${edge.to}: ${attribute} unknown`),
  );
  for (const node of nodes.values()) {
    if (node.kind === "SERVICE") {
      unknowns.push(`${node.id}: service ownership/internal-vs-external unknown`);
    }
    if (!edges.some((edge) => edge.from === node.id || edge.to === node.id)) {
      unknowns.push(`${node.id}: no runtime relationship is evidenced by this candidate diff`);
    }
  }
  if (nodes.size === 0) unknowns.push("No runtime topology is evidenced by this candidate diff.");
  return { nodes: [...nodes.values()], edges, unknowns };
};
