import { Text, Title2, makeStyles } from "@fluentui/react-components";
import { DataUsage20Regular } from "@fluentui/react-icons";
import type { Project, Run } from "../types";
import { formatCost, formatRelativeTime } from "../utils";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

const useStyles = makeStyles({
  summary: {
    padding: "20px 0",
    borderTop: "1px solid #252b31",
    borderBottom: "1px solid #252b31",
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    marginBottom: "28px",
    "@media (max-width: 650px)": { gridTemplateColumns: "1fr", gap: "18px" },
  },
  metric: {
    padding: "0 22px",
    display: "grid",
    gap: "4px",
    borderRight: "1px solid #252b31",
    ":last-child": { borderRight: 0 },
    "@media (max-width: 650px)": { padding: 0, borderRight: 0 },
  },
  value: { fontSize: "27px", lineHeight: "34px", letterSpacing: "-.03em" },
  grid: {
    display: "grid",
    gridTemplateColumns: "minmax(260px, .7fr) minmax(0, 1.3fr)",
    gap: "20px",
    alignItems: "start",
    "@media (max-width: 850px)": { gridTemplateColumns: "1fr" },
  },
  section: {
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "14px",
  },
  title: { fontSize: "19px", lineHeight: "26px" },
  rows: { display: "grid" },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "16px",
    alignItems: "center",
    minHeight: "52px",
    padding: "8px 0",
    borderBottom: "1px solid #22272c",
  },
  rowDetail: { display: "grid", gap: "3px", minWidth: 0 },
  amount: { whiteSpace: "nowrap" },
  muted: { color: "#7f8a96" },
});

const sumKnownCost = (runs: Run[]) => runs.reduce((sum, run) => sum + run.cost.total, 0);
const hasKnownCost = (runs: Run[]) => runs.some((run) => run.cost.total > 0);

export function UsagePage({ projects, runs }: { projects: Project[]; runs: Run[] }) {
  const styles = useStyles();
  const now = new Date();
  const today = runs.filter((run) => new Date(run.updatedAt).toDateString() === now.toDateString());
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - 7);
  const week = runs.filter((run) => new Date(run.updatedAt) >= weekStart);
  const agents = [...new Set(runs.map((run) => run.agent))];
  const recordedTotal = sumKnownCost(runs);
  const metricValue = (items: Run[]) =>
    hasKnownCost(items) ? formatCost(sumKnownCost(items)) : "Chưa khả dụng";
  return (
    <>
      <PageHeader
        description="Chi phí do provider thực sự báo cáo. Giá trị chưa biết không được hiển thị thành $0.00."
        title="Sử dụng"
      />
      <section className={styles.summary} aria-label="Tóm tắt sử dụng">
        <div className={styles.metric}>
          <Text className={styles.muted} size={200}>
            Hôm nay
          </Text>
          <Text className={styles.value} weight="semibold">
            {metricValue(today)}
          </Text>
          <Text className={styles.muted} size={100}>
            {hasKnownCost(today) ? "provider đã báo cáo" : "provider chưa báo cáo"}
          </Text>
        </div>
        <div className={styles.metric}>
          <Text className={styles.muted} size={200}>
            7 ngày gần đây
          </Text>
          <Text className={styles.value} weight="semibold">
            {metricValue(week)}
          </Text>
          <Text className={styles.muted} size={100}>
            {hasKnownCost(week) ? "provider đã báo cáo" : "provider chưa báo cáo"}
          </Text>
        </div>
        <div className={styles.metric}>
          <Text className={styles.muted} size={200}>
            Tổng
          </Text>
          <Text className={styles.value} weight="semibold">
            {hasKnownCost(runs) ? formatCost(recordedTotal) : "Chưa khả dụng"}
          </Text>
          <Text className={styles.muted} size={100}>
            {runs.length} tác vụ
          </Text>
        </div>
      </section>
      {runs.length ? (
        <div className={styles.grid}>
          <section className={styles.section}>
            <Title2 className={styles.title}>Theo agent</Title2>
            <div className={styles.rows}>
              {agents.map((agent) => {
                const agentRuns = runs.filter((run) => run.agent === agent);
                return (
                  <div className={styles.row} key={agent}>
                    <div className={styles.rowDetail}>
                      <Text>{agent}</Text>
                      <Text className={styles.muted} size={100}>
                        {agentRuns.length} tác vụ
                      </Text>
                    </div>
                    <Text className={styles.amount}>
                      {hasKnownCost(agentRuns)
                        ? formatCost(sumKnownCost(agentRuns))
                        : "Chi phí chưa khả dụng"}
                    </Text>
                  </div>
                );
              })}
            </div>
            {projects.length ? (
              <Text className={styles.muted} size={200}>
                Tổng hợp chính xác theo dự án dùng đường dẫn kho mã của từng tác vụ.
              </Text>
            ) : null}
          </section>
          <section className={styles.section}>
            <Title2 className={styles.title}>Sử dụng gần đây</Title2>
            <div className={styles.rows}>
              {runs.slice(0, 8).map((run) => (
                <div className={styles.row} key={run.id}>
                  <div className={styles.rowDetail}>
                    <Text>{run.task}</Text>
                    <Text className={styles.muted} size={100}>
                      {run.agent} | {formatRelativeTime(run.updatedAt)}
                    </Text>
                  </div>
                  <Text className={styles.amount}>{formatCost(run.cost.total)}</Text>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <EmptyState
          description="Dữ liệu sử dụng sẽ xuất hiện sau khi tác vụ chạy và provider báo cáo chi phí."
          icon={<DataUsage20Regular fontSize={30} />}
          title="Chưa có dữ liệu sử dụng"
        />
      )}
    </>
  );
}
