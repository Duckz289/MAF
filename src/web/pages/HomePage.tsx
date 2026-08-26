import { Button, makeStyles, Text, Title2 } from "@fluentui/react-components";
import {
  CheckmarkCircle20Regular,
  Circle20Regular,
  Folder20Regular,
  TaskListSquareLtr20Regular,
  TasksApp20Regular,
} from "@fluentui/react-icons";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskList } from "../components/TaskRow";
import type { Agent, DecisionItem, HomeData, Navigate, Project, Run } from "../types";
import { formatCost } from "../utils";

const useStyles = makeStyles({
  page: { display: "grid", gap: "26px" },
  onboarding: {
    padding: "22px 24px",
    border: "1px solid #29313a",
    borderRadius: "12px",
    backgroundColor: "#12161a",
    display: "grid",
    gridTemplateColumns: "minmax(210px, .7fr) minmax(0, 1.3fr)",
    gap: "26px",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  onboardingCopy: { display: "grid", alignContent: "start", gap: "7px" },
  setupList: { display: "grid", gap: "4px" },
  setupRow: {
    minHeight: "42px",
    padding: "7px 10px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "14px",
    borderRadius: "8px",
    ":hover": { backgroundColor: "#181c20" },
  },
  setupLabel: { display: "flex", alignItems: "center", gap: "10px" },
  complete: { color: "#70b88b" },
  incomplete: { color: "#66717d" },
  overview: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.55fr) minmax(260px, .65fr)",
    gap: "22px",
    alignItems: "start",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  section: { minWidth: 0, display: "grid", gap: "12px" },
  sectionHeader: {
    minHeight: "32px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "14px",
  },
  sectionTitle: { fontSize: "20px", lineHeight: "28px" },
  attention: {
    padding: "18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "16px",
  },
  quietRow: { display: "flex", alignItems: "center", gap: "10px", color: "#98a2ad" },
  usage: {
    marginTop: "4px",
    paddingTop: "18px",
    borderTop: "1px solid #252b31",
    display: "grid",
    gap: "4px",
  },
  amount: { fontSize: "25px", lineHeight: "32px", letterSpacing: "-.025em" },
});

const greeting = () => {
  const hour = new Date().getHours();
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
};

function Section({
  action,
  children,
  title,
}: {
  action?: React.ReactNode | undefined;
  children: React.ReactNode;
  title: string;
}) {
  const styles = useStyles();
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <Title2 className={styles.sectionTitle}>{title}</Title2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function HomePage({
  agents,
  decisions,
  home,
  navigate,
  projects,
  runs,
}: {
  agents: Agent[];
  decisions?: DecisionItem[] | undefined;
  home?: HomeData | undefined;
  navigate: Navigate;
  projects: Project[];
  runs: Run[];
}) {
  const styles = useStyles();
  const active = home?.active ?? [];
  const recent = home?.recent ?? [];
  const hasProject = projects.length > 0;
  const hasAgent = agents.some((agent) => agent.active && agent.available);
  const hasRun = runs.length > 0;
  const setupComplete = hasProject && hasAgent && hasRun;
  const setupItems = [
    { label: "Thêm dự án", complete: hasProject, action: () => navigate("/projects") },
    { label: "Kiểm tra agent AI", complete: hasAgent, action: () => navigate("/connections") },
    { label: "Chạy tác vụ đầu tiên", complete: hasRun, action: () => navigate("/runs/new") },
  ];
  return (
    <div className={styles.page}>
      <PageHeader
        description="Engineering Control Center — Project, Work, Mission, Execution, Candidate, Verification, Evidence, Trust, Delivery."
        title={greeting()}
      />

      {decisions?.length ? (
        <section className={styles.attention} aria-label="Cần quyết định">
          <div className={styles.sectionHeader}>
            <span className={styles.setupLabel}>
              <TaskListSquareLtr20Regular />
              <Title2 className={styles.sectionTitle}>Cần quyết định</Title2>
            </span>
            <Button appearance="primary" onClick={() => navigate("/decisions")}>
              Xem {decisions.length} việc
            </Button>
          </div>
          <Text className={styles.quietRow}>
            MAF không thể tự quyết định những việc này — hãy mở trang Quyết định để xử lý.
          </Text>
        </section>
      ) : null}

      {!setupComplete ? (
        <section className={styles.onboarding} aria-label="Bắt đầu với MAF">
          <div className={styles.onboardingCopy}>
            <Title2>Chào mừng đến MAF</Title2>
            <Text style={{ color: "#9ca5af", lineHeight: "21px" }}>
              Hoàn tất ba bước để giao tác vụ kỹ thuật đầu tiên.
            </Text>
            <Text size={200} style={{ color: "#75a9f2" }}>
              {setupItems.filter((item) => item.complete).length} / 3 đã hoàn tất
            </Text>
          </div>
          <div className={styles.setupList}>
            {setupItems.map((item) => (
              <div className={styles.setupRow} key={item.label}>
                <span className={styles.setupLabel}>
                  <span className={item.complete ? styles.complete : styles.incomplete}>
                    {item.complete ? <CheckmarkCircle20Regular /> : <Circle20Regular />}
                  </span>
                  <Text>{item.label}</Text>
                </span>
                {!item.complete ? (
                  <Button appearance="subtle" onClick={item.action}>
                    Tiếp tục
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className={styles.overview}>
        <div style={{ display: "grid", gap: 26, minWidth: 0 }}>
          <Section
            action={
              active.length ? (
                <Button appearance="subtle" onClick={() => navigate("/runs")}>
                  Xem tất cả
                </Button>
              ) : undefined
            }
            title="Công việc đang chạy"
          >
            {active.length ? (
              <TaskList navigate={navigate} runs={active} />
            ) : (
              <EmptyState
                actionLabel="Tạo tác vụ"
                description="Bắt đầu một tác vụ và MAF sẽ quản lý quá trình triển khai cùng xác minh."
                icon={<TasksApp20Regular fontSize={28} />}
                onAction={() => navigate("/runs/new")}
                title="Chưa có việc đang chạy"
              />
            )}
          </Section>
          <Section
            action={
              <Button appearance="subtle" onClick={() => navigate("/runs")}>
                Lịch sử tác vụ
              </Button>
            }
            title="Kết quả gần đây"
          >
            {recent.length ? (
              <TaskList navigate={navigate} runs={recent.slice(0, 4)} />
            ) : (
              <EmptyState
                description="Kết quả triển khai và xác minh sẽ xuất hiện tại đây."
                icon={<Folder20Regular fontSize={28} />}
                title="Chưa có kết quả"
              />
            )}
          </Section>
        </div>
        <aside className={styles.attention}>
          <div className={styles.sectionHeader}>
            <Title2 className={styles.sectionTitle}>Cần chú ý</Title2>
            <Text size={200} style={{ color: "#7f8a96" }}>
              {home?.attention.length ?? 0} mục
            </Text>
          </div>
          {home?.attention.length ? (
            <TaskList navigate={navigate} runs={home.attention.slice(0, 3)} />
          ) : (
            <div className={styles.quietRow}>
              <CheckmarkCircle20Regular />
              <Text>Không có việc nào cần bạn xử lý.</Text>
            </div>
          )}
          <div className={styles.usage}>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Sử dụng đã ghi nhận
            </Text>
            <Text className={styles.amount} weight="semibold">
              {home?.usage.hasKnownCost
                ? formatCost(home.usage.totalRecorded)
                : "Chi phí chưa khả dụng"}
            </Text>
            <Button appearance="subtle" onClick={() => navigate("/usage")}>
              Xem chi tiết sử dụng
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
