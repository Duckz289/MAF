import { Badge, Button, makeStyles, Tab, TabList, Text, Title2 } from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  Code20Regular,
  Folder20Regular,
  HeartPulse20Regular,
} from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskList } from "../components/TaskRow";
import {
  healthDirectionLabel,
  healthDirectionTone,
  healthMetricLabel,
  productionImpactLabel,
} from "../status";
import type { HealthLedger, Navigate, Project, Run } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  tabs: { marginBottom: "22px", borderBottom: "1px solid #252b31" },
  overview: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.25fr) minmax(280px, .75fr)",
    gap: "18px",
    "@media (max-width: 850px)": { gridTemplateColumns: "1fr" },
  },
  panel: {
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "16px",
  },
  facts: { display: "grid", gap: "15px" },
  fact: { display: "grid", gap: "4px" },
  mono: { fontFamily: '"Cascadia Code", Consolas, monospace', overflowWrap: "anywhere" },
  headline: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "16px 18px",
    borderRadius: "10px",
    backgroundColor: "#0f1113",
  },
  trendRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "14px",
    alignItems: "start",
    padding: "10px 0",
    borderBottom: "1px solid #1c2126",
  },
  quiet: { color: "#7f8a96" },
});

export function ProjectPage({
  navigate,
  project,
  runs,
}: {
  navigate: Navigate;
  project?: Project | undefined;
  runs: Run[];
}) {
  const styles = useStyles();
  const [tab, setTab] = useState("overview");
  const [health, setHealth] = useState<HealthLedger>();
  useEffect(() => {
    if (!project) return;
    void readJson<HealthLedger>(
      `/api/v1/health-ledger?repositoryPath=${encodeURIComponent(project.repositoryPath)}`,
    )
      .then(setHealth)
      .catch(() => setHealth(undefined));
  }, [project]);
  if (!project)
    return (
      <EmptyState
        actionLabel="Quay lại dự án"
        description="Dự án này không tồn tại trong tiến trình local hiện tại."
        onAction={() => navigate("/projects")}
        title="Không tìm thấy dự án"
      />
    );
  const projectRuns = runs.filter((run) => run.repositoryPath === project.repositoryPath);
  return (
    <>
      <PageHeader
        description={`${project.repositoryPath}  |  ${project.revision}`}
        title={project.name}
      />
      <Button
        appearance="subtle"
        icon={<ArrowLeft20Regular />}
        onClick={() => navigate("/projects")}
        style={{ marginBottom: 10 }}
      >
        Tất cả dự án
      </Button>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_event, data) => setTab(String(data.value))}
      >
        <Tab value="overview">Tổng quan</Tab>
        <Tab value="tasks">Tác vụ</Tab>
        <Tab value="health">Sức khỏe</Tab>
        <Tab value="files">Tệp và ngữ cảnh</Tab>
        <Tab value="settings">Cài đặt</Tab>
      </TabList>
      {tab === "overview" ? (
        <div className={styles.overview}>
          <section style={{ display: "grid", gap: 12 }}>
            <Title2>Tác vụ gần đây</Title2>
            {projectRuns.length ? (
              <TaskList navigate={navigate} runs={projectRuns.slice(0, 5)} />
            ) : (
              <EmptyState
                actionLabel="Tạo tác vụ"
                description="Giao một thay đổi kỹ thuật để bắt đầu lịch sử của dự án."
                onAction={() => navigate(`/runs/new?project=${project.id}`)}
                title="Dự án chưa có tác vụ"
              />
            )}
          </section>
          <aside className={styles.panel}>
            <Title2>Ngữ cảnh dự án</Title2>
            <div className={styles.facts}>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Kho mã local
                </Text>
                <Text className={styles.mono}>{project.repositoryPath}</Text>
              </div>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Revision
                </Text>
                <Text>{project.revision}</Text>
              </div>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Agent mặc định
                </Text>
                <Text>Tự động theo server</Text>
              </div>
            </div>
          </aside>
        </div>
      ) : null}
      {tab === "tasks" ? (
        projectRuns.length ? (
          <TaskList navigate={navigate} runs={projectRuns} />
        ) : (
          <EmptyState description="Tác vụ của dự án sẽ xuất hiện ở đây." title="Chưa có tác vụ" />
        )
      ) : null}
      {tab === "health" ? <ProjectHealthPanel health={health} /> : null}
      {tab === "files" ? (
        <div className={styles.panel}>
          <Folder20Regular fontSize={28} />
          <Title2>Ngữ cảnh từ kho mã local</Title2>
          <Text style={{ color: "#9ca5af" }}>
            MAF lập chỉ mục kho mã khi tác vụ bắt đầu. Project Graph và snapshot kỹ thuật chỉ hiển
            thị trong phần Nâng cao của tác vụ.
          </Text>
          <Text className={styles.mono}>{project.repositoryPath}</Text>
        </div>
      ) : null}
      {tab === "settings" ? (
        <div className={styles.panel}>
          <Code20Regular fontSize={28} />
          <Title2>Cài đặt dự án</Title2>
          <Text style={{ color: "#9ca5af" }}>
            Bản dựng hiện tại chưa hỗ trợ cập nhật dự án sau khi thêm. Các giá trị bên dưới là chỉ
            đọc.
          </Text>
          <div className={styles.facts}>
            <div className={styles.fact}>
              <Text size={200}>Ưu tiên chất lượng</Text>
              <Text>{project.preferences.qualityPreference ?? "Cân bằng"}</Text>
            </div>
            <div className={styles.fact}>
              <Text size={200}>Ưu tiên ngân sách</Text>
              <Text>{project.preferences.budgetPreference ?? "Tự động"}</Text>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const overallHealthLabel = (health: HealthLedger | undefined): string => {
  if (!health || health.samples.length < 2) return "Chưa đủ bằng chứng";
  if (health.maintenance?.needed) return "Đang xuống cấp";
  const classified = health.trend?.metrics.filter((metric) => metric.direction !== "UNKNOWN") ?? [];
  if (classified.some((metric) => metric.direction === "DEGRADING")) return "Đang xuống cấp";
  if (classified.some((metric) => metric.direction === "IMPROVING")) return "Đang cải thiện";
  return "Ổn định";
};

function ProjectHealthPanel({ health }: { health?: HealthLedger | undefined }) {
  const styles = useStyles();
  if (!health || health.samples.length === 0)
    return (
      <EmptyState
        description="Cần thêm tác vụ đã hoàn tất và xác minh trước khi MAF có thể đánh giá xu hướng sức khỏe kho mã."
        title="Chưa có dữ liệu sức khỏe"
      />
    );
  const overall = overallHealthLabel(health);
  const notableMetrics = (health.trend?.metrics ?? []).filter(
    (metric) => metric.direction === "DEGRADING" || metric.direction === "IMPROVING",
  );
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className={styles.headline}>
        <HeartPulse20Regular fontSize={22} />
        <div>
          <Text weight="semibold">{overall}</Text>
          <Text block className={styles.quiet} size={200}>
            Dựa trên {health.samples.length} lần đo từ các tác vụ đã xác minh gần đây
            {health.trend?.incomplete ? " — một số phép so sánh chưa đủ dữ liệu để phân loại" : ""}.
          </Text>
        </div>
      </div>
      <div className={styles.panel}>
        <Title2>Xu hướng chính</Title2>
        {notableMetrics.length ? (
          notableMetrics.map((metric) => (
            <div className={styles.trendRow} key={metric.metric}>
              <div>
                <Text>{healthMetricLabel(metric.metric)}</Text>
                <Text block className={styles.quiet} size={200}>
                  {metric.previous} → {metric.current}
                  {metric.note ? ` — ${metric.note}` : ""}
                </Text>
              </div>
              <Badge appearance="tint" color={healthDirectionTone(metric.direction)}>
                {healthDirectionLabel(metric.direction)}
              </Badge>
            </div>
          ))
        ) : (
          <Text className={styles.quiet}>Không có thay đổi đáng chú ý ở lần đo gần nhất.</Text>
        )}
      </div>
      {health.maintenance?.needed ? (
        <div className={styles.panel}>
          <Title2>Đề xuất bảo trì</Title2>
          {health.maintenance.reasons.map((reason) => (
            <Text block className={styles.mono} key={reason} size={200}>
              • {reason}
            </Text>
          ))}
          {health.maintenance.escalationCorrelationNote ? (
            <Text className={styles.quiet} size={200}>
              {health.maintenance.escalationCorrelationNote}
            </Text>
          ) : null}
        </div>
      ) : null}
      <div className={styles.panel}>
        <Title2>Ảnh hưởng production</Title2>
        <Text>{productionImpactLabel(health.productionImpact.state)}</Text>
        {health.productionImpact.reasons.map((reason) => (
          <Text block className={styles.quiet} key={reason} size={200}>
            {reason}
          </Text>
        ))}
      </div>
    </div>
  );
}
