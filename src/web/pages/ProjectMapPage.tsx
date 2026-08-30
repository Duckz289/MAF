import { Button, Input, makeStyles, Text, Title2 } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import type { ProjectMapReadModel } from "../../domain/control-center";
import { AuthorityBadge } from "../components/AuthorityBadge";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { readJson } from "../utils";

const useStyles = makeStyles({
  root: { display: "grid", gap: "14px" },
  toolbar: { display: "flex", gap: "8px", flexWrap: "wrap" },
  list: { display: "grid", gap: "8px" },
  node: {
    padding: "12px 14px",
    border: "1px solid #252b31",
    borderRadius: "10px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "4px",
  },
  meta: { display: "flex", gap: "8px", flexWrap: "wrap", color: "#7f8a96" },
  quiet: { color: "#7f8a96" },
});

export function ProjectMapPanel({ projectId }: { projectId: string }) {
  const styles = useStyles();
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<string>();
  const [map, setMap] = useState<ProjectMapReadModel>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const params = new URLSearchParams({ limit: "16" });
    if (search.trim()) params.set("search", search.trim());
    if (focus) params.set("focus", focus);
    let cancelled = false;
    void readJson<ProjectMapReadModel>(
      `/api/v1/control-center/projects/${projectId}/map?${params.toString()}`,
    )
      .then((next) => {
        if (!cancelled) {
          setMap(next);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [focus, projectId, search]);

  if (error) return <EmptyState description={error} title="Project Map unavailable" />;
  if (!map) return <LoadingState />;

  return (
    <div className={styles.root}>
      <Title2>Project Map</Title2>
      <Text className={styles.quiet}>
        Bounded navigation over MAF-owned modules and files. Edges are not trust. Knowledge
        summaries are not verified truth.
      </Text>
      <div className={styles.toolbar}>
        <Input
          placeholder="Search modules"
          value={search}
          onChange={(_event, data) => setSearch(data.value)}
        />
        <Button disabled={!map.nextCursor} onClick={() => undefined}>
          {map.truncated ? "More available" : "End of page"}
        </Button>
      </div>
      <Text className={styles.quiet}>
        Knowledge: current {map.knowledge.current} · stale {map.knowledge.stale} · conflicted{" "}
        {map.knowledge.conflicted} · unknown {map.knowledge.unknown}
      </Text>
      <Text className={styles.quiet}>
        Neighborhood: {map.neighborhood.status} — {map.neighborhood.reason}
      </Text>
      <div className={styles.list}>
        {map.nodes
          .filter((node) => node.kind === "MODULE" || node.kind === "KNOWLEDGE")
          .map((node) => (
            <button
              className={styles.node}
              key={node.id}
              type="button"
              onClick={() => {
                if (node.kind === "MODULE" && node.path) setFocus(node.path);
              }}
            >
              <Text weight="semibold">{node.label}</Text>
              <div className={styles.meta}>
                <AuthorityBadge authority={node.authority} />
                <span>{node.kind}</span>
                {node.flags.map((flag) => (
                  <span key={flag}>{flag}</span>
                ))}
              </div>
            </button>
          ))}
      </div>
      {map.nodes.length === 0 ? (
        <Text className={styles.quiet}>
          No map nodes on this page. The repository may be unavailable on this host.
        </Text>
      ) : null}
    </div>
  );
}
