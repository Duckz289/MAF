import { Button, makeStyles, Text } from "@fluentui/react-components";
import { ChevronRight20Regular } from "@fluentui/react-icons";
import type { Navigate, Run } from "../types";
import { formatCost, formatRelativeTime, friendlyMode, translatedValue } from "../utils";
import { RunStatusBadge } from "./StatusBadge";

const useStyles = makeStyles({
  row: {
    minHeight: "80px",
    padding: "15px 14px 15px 17px",
    border: "1px solid #252b31",
    borderRadius: "8px",
    backgroundColor: "#111315",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "18px",
    transitionProperty: "background-color, border-color, transform",
    transitionDuration: "160ms",
    "@media (max-width: 620px)": { gridTemplateColumns: "1fr", gap: "10px" },
  },
  main: { minWidth: 0, display: "grid", gap: "5px" },
  titleLine: { display: "flex", alignItems: "center", gap: "9px", flexWrap: "wrap" },
  title: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  phase: { color: "#aeb6bf" },
  meta: { display: "flex", gap: "8px 14px", flexWrap: "wrap", color: "#7f8a96" },
  action: { justifySelf: "end", "@media (max-width: 620px)": { justifySelf: "start" } },
});

export function TaskRow({ navigate, run }: { navigate: Navigate; run: Run }) {
  const styles = useStyles();
  return (
    <article className={styles.row}>
      <div className={styles.main}>
        <div className={styles.titleLine}>
          <Text className={styles.title} weight="semibold">
            {run.task}
          </Text>
          <RunStatusBadge run={run} />
        </div>
        <Text className={styles.phase} size={200}>
          {translatedValue(run.currentPhase)}
        </Text>
        <div className={styles.meta}>
          <Text size={200}>{run.agent}</Text>
          <Text size={200}>{friendlyMode(run.executionMode)}</Text>
          <Text size={200}>{formatCost(run.cost.total)}</Text>
          <Text size={200}>{formatRelativeTime(run.updatedAt)}</Text>
        </div>
      </div>
      <Button
        appearance="subtle"
        className={styles.action}
        icon={<ChevronRight20Regular />}
        iconPosition="after"
        onClick={() => navigate(`/runs/${run.id}`)}
      >
        Mở
      </Button>
    </article>
  );
}

export function TaskList({ navigate, runs }: { navigate: Navigate; runs: Run[] }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {runs.map((run) => (
        <TaskRow key={run.id} navigate={navigate} run={run} />
      ))}
    </div>
  );
}
