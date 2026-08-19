import {
  Badge,
  Button,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  FluentProvider,
  MessageBar,
  MessageBarBody,
  Spinner,
  Subtitle1,
  Tab,
  TabList,
  Title1,
  Tooltip,
  createTableColumn,
  makeStyles,
  tokens,
  webDarkTheme,
  type TableColumnDefinition,
} from "@fluentui/react-components";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Run {
  id: string;
  state: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  executionMode: "STRICT" | "GUIDED" | "SOLO_NATIVE";
  verificationState: string;
  agent: string;
  model: string;
  updatedAt: string;
  changedFiles: string[];
  error?: string;
  cost: { total: number };
  usage: { input: number; output: number; cached: number };
  task: string;
  currentPhase: string;
  lastMeaningfulEvent?: { type: string; timestamp: string };
  modeTransitions: number;
  operationalStatus: string;
}

interface MissionNode {
  id: string;
  state: string;
  dependencyIds: string[];
  verificationState: string;
  executionMode: string;
}

interface Mission {
  id: string;
  nodes: MissionNode[];
}

const useStyles = makeStyles({
  shell: { minHeight: "100dvh", backgroundColor: tokens.colorNeutralBackground1 },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    "@media (max-width: 900px)": {
      alignItems: "flex-start",
      gap: tokens.spacingHorizontalM,
      padding: tokens.spacingHorizontalM,
    },
  },
  heading: { display: "grid", gap: tokens.spacingVerticalXS },
  content: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 280px",
    gap: tokens.spacingHorizontalXL,
    maxWidth: "1600px",
    margin: "0 auto",
    padding: tokens.spacingHorizontalXXL,
    "@media (max-width: 900px)": {
      gridTemplateColumns: "1fr",
      padding: tokens.spacingHorizontalM,
    },
  },
  panel: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
    overflow: "hidden",
  },
  toolbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: tokens.spacingHorizontalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  summary: { display: "grid", gap: tokens.spacingVerticalL, alignContent: "start" },
  mission: {
    display: "grid",
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  missionNode: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  metric: {
    display: "grid",
    gap: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  metricValue: { fontSize: tokens.fontSizeBase600, fontWeight: tokens.fontWeightSemibold },
  mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" },
  error: { color: tokens.colorPaletteRedForeground1 },
  empty: { padding: tokens.spacingHorizontalXXL, textAlign: "center" },
});

const statusColor = (run: Run): "success" | "danger" | "warning" | "informative" | "subtle" => {
  if (run.verificationState === "VERIFIED") return "success";
  if (run.state === "FAILED" || run.operationalStatus === "STUCK") return "danger";
  if (run.state === "RUNNING") return "informative";
  if (run.state === "QUEUED") return "warning";
  return "subtle";
};

export function App() {
  const styles = useStyles();
  const [runs, setRuns] = useState<Run[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const [runsResponse, missionsResponse] = await Promise.all([
        fetch("/api/v1/runs"),
        fetch("/api/v1/missions"),
      ]);
      if (!runsResponse.ok) throw new Error(`Run query failed with ${runsResponse.status}`);
      if (!missionsResponse.ok) {
        throw new Error(`Mission query failed with ${missionsResponse.status}`);
      }
      setRuns((await runsResponse.json()) as Run[]);
      setMissions((await missionsResponse.json()) as Mission[]);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const filtered = useMemo(
    () =>
      runs.filter((run) => {
        if (filter === "active") return run.state === "RUNNING" || run.state === "QUEUED";
        if (filter === "failed") return run.state === "FAILED";
        if (filter === "verified") return run.verificationState === "VERIFIED";
        return true;
      }),
    [runs, filter],
  );

  const columns: TableColumnDefinition<Run>[] = [
    createTableColumn<Run>({
      columnId: "run",
      renderHeaderCell: () => "Run",
      renderCell: (item) => (
        <Tooltip content={item.id} relationship="description">
          <span className={styles.mono}>{item.id.slice(0, 8)}</span>
        </Tooltip>
      ),
    }),
    createTableColumn<Run>({
      columnId: "status",
      renderHeaderCell: () => "Status",
      renderCell: (item) => (
        <Badge appearance="tint" color={statusColor(item)}>
          {item.operationalStatus}
        </Badge>
      ),
    }),
    createTableColumn<Run>({
      columnId: "task",
      renderHeaderCell: () => "Task and phase",
      renderCell: (item) => (
        <Tooltip
          content={`${item.task} | last: ${item.lastMeaningfulEvent?.type ?? "none"}`}
          relationship="description"
        >
          <span>{item.currentPhase}</span>
        </Tooltip>
      ),
    }),
    createTableColumn<Run>({
      columnId: "mode",
      renderHeaderCell: () => "Mode",
      renderCell: (item) => item.executionMode,
    }),
    createTableColumn<Run>({
      columnId: "verification",
      renderHeaderCell: () => "Verification",
      renderCell: (item) => item.verificationState,
    }),
    createTableColumn<Run>({
      columnId: "agent",
      renderHeaderCell: () => "Agent / model",
      renderCell: (item) => `${item.agent} / ${item.model}`,
    }),
    createTableColumn<Run>({
      columnId: "transitions",
      renderHeaderCell: () => "Mode changes",
      renderCell: (item) => item.modeTransitions,
    }),
    createTableColumn<Run>({
      columnId: "usage",
      renderHeaderCell: () => "Tokens",
      renderCell: (item) =>
        (item.usage.input + item.usage.output + item.usage.cached).toLocaleString(),
    }),
    createTableColumn<Run>({
      columnId: "changes",
      renderHeaderCell: () => "Files",
      renderCell: (item) => item.changedFiles.length,
    }),
    createTableColumn<Run>({
      columnId: "cost",
      renderHeaderCell: () => "Cost",
      renderCell: (item) => `$${item.cost.total.toFixed(4)}`,
    }),
  ];

  const active = runs.filter((run) => run.state === "RUNNING").length;
  const queued = runs.filter((run) => run.state === "QUEUED").length;
  const failed = runs.filter((run) => run.state === "FAILED").length;
  const verified = runs.filter((run) => run.verificationState === "VERIFIED").length;
  const totalCost = runs.reduce((sum, run) => sum + run.cost.total, 0);

  return (
    <FluentProvider theme={webDarkTheme} className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Title1>Adaptive Harness Control</Title1>
          <Subtitle1>Native agent execution, verification, and cost in one view</Subtitle1>
        </div>
        <Button appearance="primary" onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>
      <main className={styles.content}>
        <section className={styles.panel} aria-label="Runs">
          <div className={styles.toolbar}>
            <TabList
              selectedValue={filter}
              onTabSelect={(_event, data) => setFilter(String(data.value))}
            >
              <Tab value="all">All</Tab>
              <Tab value="active">Active</Tab>
              <Tab value="failed">Failed</Tab>
              <Tab value="verified">Verified</Tab>
            </TabList>
            <span>{filtered.length} runs</span>
          </div>
          {error ? (
            <MessageBar intent="error">
              <MessageBarBody>{error}</MessageBarBody>
            </MessageBar>
          ) : null}
          {loading ? (
            <div className={styles.empty}>
              <Spinner label="Loading runs" />
            </div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}>No runs match this view.</div>
          ) : (
            <DataGrid items={filtered} columns={columns} sortable>
              <DataGridHeader>
                <DataGridRow>
                  {({ renderHeaderCell }) => (
                    <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                  )}
                </DataGridRow>
              </DataGridHeader>
              <DataGridBody<Run>>
                {({ item, rowId }) => (
                  <DataGridRow<Run> key={rowId}>
                    {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                  </DataGridRow>
                )}
              </DataGridBody>
            </DataGrid>
          )}
        </section>
        <aside className={styles.summary} aria-label="Operational summary">
          <div className={styles.metric}>
            <span>Running</span>
            <span className={styles.metricValue}>{active}</span>
          </div>
          <div className={styles.metric}>
            <span>Queued</span>
            <span className={styles.metricValue}>{queued}</span>
          </div>
          <div className={styles.metric}>
            <span>Verified</span>
            <span className={styles.metricValue}>{verified}</span>
          </div>
          <div className={styles.metric}>
            <span>Failed or quarantined</span>
            <span className={`${styles.metricValue} ${failed ? styles.error : ""}`}>{failed}</span>
          </div>
          <div className={styles.metric}>
            <span>Recorded cost</span>
            <span className={styles.metricValue}>${totalCost.toFixed(4)}</span>
          </div>
          <MessageBar intent="info">
            <MessageBarBody>
              Runs waiting on mission dependencies remain queued until every required output is
              verified.
            </MessageBarBody>
          </MessageBar>
          {missions.map((mission) => (
            <section
              key={mission.id}
              className={styles.mission}
              aria-label={`Mission ${mission.id}`}
            >
              <Subtitle1>Mission {mission.id}</Subtitle1>
              {mission.nodes.map((node) => (
                <div key={node.id} className={styles.missionNode}>
                  <Tooltip
                    content={`${node.executionMode}; waits on ${node.dependencyIds.join(", ") || "none"}`}
                    relationship="description"
                  >
                    <span className={styles.mono}>{node.id}</span>
                  </Tooltip>
                  <Badge
                    appearance="tint"
                    color={node.verificationState === "VERIFIED" ? "success" : "informative"}
                  >
                    {node.state}
                  </Badge>
                </div>
              ))}
            </section>
          ))}
        </aside>
      </main>
    </FluentProvider>
  );
}
