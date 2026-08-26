import {
  Badge,
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  makeStyles,
  Select,
  Spinner,
  Tab,
  TabList,
  Text,
  Title2,
} from "@fluentui/react-components";
import {
  ArrowClockwise20Regular,
  ArrowLeft20Regular,
  CheckmarkCircle20Regular,
  Circle20Regular,
  HeartPulse20Regular,
  LockClosed20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskList } from "../components/TaskRow";
import { qualityPreferenceDescription } from "../presentation";
import {
  healthDirectionLabel,
  healthDirectionTone,
  healthMetricLabel,
  productionImpactLabel,
} from "../status";
import type { Agent, HealthLedger, Navigate, Project, ProjectDetection, Run } from "../types";
import { formatCost, friendlyMode, readJson } from "../utils";
import { ProjectMapPanel } from "./ProjectMapPage";

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
  chipRow: { display: "flex", gap: "6px", flexWrap: "wrap" },
  capabilityRow: { display: "flex", alignItems: "center", gap: "9px", padding: "5px 0" },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  controlsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "16px",
    "@media (max-width: 650px)": { gridTemplateColumns: "1fr" },
  },
  budgetRow: { display: "grid", gridTemplateColumns: "1fr auto", gap: "6px" },
  budgetBar: { height: "8px", borderRadius: "4px", backgroundColor: "#1c2126", overflow: "hidden" },
  budgetFill: { height: "100%", backgroundColor: "#5791e5" },
});

/** Static, code-true engine invariants — never a per-project toggle because the engine has no
 * policy hook to disable them. Shown as information, never as a functional control. */
const alwaysAutomatic = [
  "Sửa file trong worktree cô lập của tác vụ",
  "Chạy test/build/typecheck đã phát hiện để xác minh",
  "Thử lại giới hạn khi provider gặp lỗi tạm thời",
  "Điều chỉnh mức độ giám sát (STRICT/GUIDED/SOLO_NATIVE) dựa trên tín hiệu có bằng chứng",
];
const alwaysRequiresApproval = [
  "Vượt ngân sách ở chế độ giới hạn cứng (HARD)",
  "Bàn giao/merge — MAF không bao giờ tự merge, luôn cần phê duyệt bên ngoài",
  "Tiếp tục sau khi phát hiện bảo mật chặn ứng viên",
];

const capabilityLabels: Record<string, string> = {
  fileRead: "Đọc file trong kho mã",
  fileWrite: "Sửa file trong worktree",
  shell: "Chạy lệnh cục bộ",
  repoSearch: "Tìm kiếm trong kho mã",
  browser: "Điều khiển trình duyệt",
  mcp: "Kết nối MCP",
  nativePlanning: "Lập kế hoạch native",
  nativeSubagents: "Subagent native",
  contextManagement: "Quản lý ngữ cảnh native",
  resumeSession: "Tiếp tục phiên đã tạm dừng",
  livePolicyUpdate: "Cập nhật chính sách khi đang chạy",
};

export function ProjectPage({
  agents,
  navigate,
  project,
  refresh,
  runs,
}: {
  agents: Agent[];
  navigate: Navigate;
  project?: Project | undefined;
  refresh: () => Promise<void>;
  runs: Run[];
}) {
  const styles = useStyles();
  const [tab, setTab] = useState("overview");
  const [health, setHealth] = useState<HealthLedger>();
  const [detection, setDetection] = useState<ProjectDetection>();
  const [detecting, setDetecting] = useState(false);

  const loadDetection = useCallback(async (repositoryPath: string) => {
    setDetecting(true);
    try {
      const response = await fetch("/api/v1/filesystem/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryPath }),
      });
      setDetection(response.ok ? await response.json() : undefined);
    } catch {
      setDetection(undefined);
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    if (!project) return;
    void readJson<HealthLedger>(
      `/api/v1/health-ledger?repositoryPath=${encodeURIComponent(project.repositoryPath)}`,
    )
      .then(setHealth)
      .catch(() => setHealth(undefined));
    void loadDetection(project.repositoryPath);
  }, [project, loadDetection]);

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
  const activeAgent = agents.find((agent) => agent.active && agent.capabilities);
  const spent = projectRuns.reduce((sum, run) => sum + run.cost.total, 0);
  const limit = project.preferences.budgetLimitUsd;

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
        <Tab value="map">Project Map</Tab>
        <Tab value="tasks">Tác vụ</Tab>
        <Tab value="health">Sức khỏe</Tab>
        <Tab value="understanding">Hiểu biết</Tab>
        <Tab value="controls">Kiểm soát</Tab>
      </TabList>
      {tab === "map" ? <ProjectMapPanel projectId={project.id} /> : null}
      {tab === "overview" ? (
        <div className={styles.overview}>
          <section style={{ display: "grid", gap: 20 }}>
            <div>
              <Title2>Tác vụ gần đây</Title2>
              <div style={{ marginTop: 12 }}>
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
              </div>
            </div>
            <div className={styles.panel}>
              <div className={styles.sectionHead}>
                <Title2>MAF hiểu gì về dự án này</Title2>
                <Button appearance="subtle" onClick={() => setTab("understanding")} size="small">
                  Xem chi tiết
                </Button>
              </div>
              {detecting ? (
                <Spinner size="tiny" />
              ) : detection?.exists ? (
                <div className={styles.chipRow}>
                  {[...detection.languages, ...detection.frameworks].length ? (
                    [...detection.languages, ...detection.frameworks].map((chip) => (
                      <Badge appearance="tint" key={chip}>
                        {chip}
                      </Badge>
                    ))
                  ) : (
                    <Text className={styles.quiet} size={200}>
                      Chưa phát hiện ngôn ngữ/framework cụ thể.
                    </Text>
                  )}
                  {detection.git.present ? (
                    <Badge appearance="outline">
                      {detection.git.branch} · {detection.git.revision}
                    </Badge>
                  ) : (
                    <Badge appearance="tint" color="warning">
                      Không phải kho Git
                    </Badge>
                  )}
                </div>
              ) : (
                <Text className={styles.quiet} size={200}>
                  Chưa thể phát hiện thông tin dự án.
                </Text>
              )}
            </div>
          </section>
          <aside style={{ display: "grid", gap: 18 }}>
            <div className={styles.panel}>
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
                    Agent đang hoạt động
                  </Text>
                  <Text>{activeAgent?.name ?? "Do server chọn"}</Text>
                </div>
              </div>
            </div>
            <div className={styles.panel}>
              <div className={styles.sectionHead}>
                <Title2>Sức khỏe</Title2>
                <Button appearance="subtle" onClick={() => setTab("health")} size="small">
                  Xem chi tiết
                </Button>
              </div>
              <Text>{overallHealthLabel(health)}</Text>
            </div>
            <div className={styles.panel}>
              <div className={styles.sectionHead}>
                <Title2>Ngân sách</Title2>
                <Button appearance="subtle" onClick={() => setTab("controls")} size="small">
                  Cấu hình
                </Button>
              </div>
              <BudgetBar limit={limit} spent={spent} />
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
      {tab === "understanding" ? (
        <UnderstandingPanel
          detecting={detecting}
          detection={detection}
          onRefresh={() => void loadDetection(project.repositoryPath)}
        />
      ) : null}
      {tab === "controls" ? (
        <ControlsPanel agent={activeAgent} project={project} refresh={refresh} />
      ) : null}
    </>
  );
}

function BudgetBar({ limit, spent }: { limit: number | undefined; spent: number }) {
  const styles = useStyles();
  if (limit === undefined) {
    return (
      <>
        <Text className={styles.quiet} size={200}>
          Chưa đặt giới hạn ngân sách cho dự án.
        </Text>
        <Text size={200}>Đã dùng: {spent > 0 ? formatCost(spent) : "Chi phí chưa khả dụng"}</Text>
      </>
    );
  }
  const ratio = limit > 0 ? Math.min(1, spent / limit) : 0;
  return (
    <>
      <div className={styles.budgetRow}>
        <Text size={200}>Đã dùng {formatCost(spent)}</Text>
        <Text size={200}>Giới hạn {formatCost(limit)}</Text>
      </div>
      <div className={styles.budgetBar}>
        <div className={styles.budgetFill} style={{ width: `${ratio * 100}%` }} />
      </div>
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

function UnderstandingPanel({
  detecting,
  detection,
  onRefresh,
}: {
  detecting: boolean;
  detection: ProjectDetection | undefined;
  onRefresh: () => void;
}) {
  const styles = useStyles();
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className={styles.sectionHead}>
        <Text className={styles.quiet} size={200}>
          Được phát hiện trực tiếp từ kho mã — không phải suy luận từ mô hình.
        </Text>
        <Button
          appearance="subtle"
          disabled={detecting}
          icon={<ArrowClockwise20Regular />}
          onClick={onRefresh}
        >
          {detecting ? "Đang làm mới" : "Làm mới"}
        </Button>
      </div>
      {!detection?.exists ? (
        <EmptyState
          description="Đường dẫn kho mã hiện không truy cập được từ server, hoặc chưa từng được phát hiện."
          title="Chưa có thông tin dự án"
        />
      ) : (
        <>
          <div className={styles.panel}>
            <Title2>Tóm tắt</Title2>
            <div className={styles.facts}>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Ngôn ngữ
                </Text>
                <div className={styles.chipRow}>
                  {detection.languages.length ? (
                    detection.languages.map((language) => (
                      <Badge appearance="tint" key={language}>
                        {language}
                      </Badge>
                    ))
                  ) : (
                    <Text size={200}>Chưa xác định</Text>
                  )}
                </div>
              </div>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Framework
                </Text>
                <div className={styles.chipRow}>
                  {detection.frameworks.length ? (
                    detection.frameworks.map((framework) => (
                      <Badge appearance="tint" color="informative" key={framework}>
                        {framework}
                      </Badge>
                    ))
                  ) : (
                    <Text size={200}>Chưa xác định</Text>
                  )}
                </div>
              </div>
              <div className={styles.fact}>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Package manager
                </Text>
                <Text>{detection.packageManager ?? "Chưa xác định"}</Text>
              </div>
            </div>
          </div>
          <div className={styles.panel}>
            <Title2>Kiến trúc</Title2>
            <Text>
              {detection.monorepo
                ? `Monorepo với ${detection.moduleRoots.length} package/module`
                : "Một package duy nhất"}
            </Text>
            {detection.moduleRoots.length ? (
              <div className={styles.chipRow}>
                {detection.moduleRoots.slice(0, 24).map((root) => (
                  <Badge appearance="outline" key={root}>
                    {root}
                  </Badge>
                ))}
                {detection.moduleRoots.length > 24 ? (
                  <Text className={styles.quiet} size={200}>
                    +{detection.moduleRoots.length - 24} khác
                  </Text>
                ) : null}
              </div>
            ) : null}
            <Text className={styles.quiet} size={200}>
              {detection.trackedFileCount !== undefined
                ? `${detection.trackedFileCount}${detection.trackedFileCountTruncated ? "+" : ""} tệp được Git theo dõi`
                : "Chưa đếm được số tệp"}
            </Text>
          </div>
          <div className={styles.panel}>
            <Title2>Xác minh</Title2>
            {detection.verificationCommands.length ? (
              detection.verificationCommands.map((entry) => (
                <div className={styles.fact} key={entry.command}>
                  <Text size={200} style={{ color: "#7f8a96" }}>
                    {entry.label}
                  </Text>
                  <Text className={styles.mono}>{entry.command}</Text>
                </div>
              ))
            ) : (
              <Text className={styles.quiet}>
                Chưa phát hiện lệnh xác minh nào trong package.json.
              </Text>
            )}
          </div>
          <div className={styles.panel}>
            <Title2>Quy tắc và kiến thức dự án</Title2>
            <Text className={styles.quiet} size={200}>
              MAF chưa ghi nhận fact hay quyết định nào được xác minh cho dự án này. Kiến thức dự án
              tích lũy qua các tác vụ đã hoàn tất; mục này sẽ có nội dung khi có bằng chứng.
            </Text>
          </div>
          {detection.unknowns.length ? (
            <div className={styles.panel}>
              <Title2>Chưa xác định</Title2>
              {detection.unknowns.map((unknown) => (
                <Text block className={styles.mono} key={unknown} size={200}>
                  {unknown}
                </Text>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function ControlsPanel({
  agent,
  project,
  refresh,
}: {
  agent: Agent | undefined;
  project: Project;
  refresh: () => Promise<void>;
}) {
  const styles = useStyles();
  const [quality, setQuality] = useState(project.preferences.qualityPreference ?? "BALANCED");
  const [executionMode, setExecutionMode] = useState(
    project.preferences.executionModePreference ?? "AUTO",
  );
  const [budgetMode, setBudgetMode] = useState(project.preferences.budgetMode ?? "ADVISORY");
  const [budgetLimit, setBudgetLimit] = useState(
    project.preferences.budgetLimitUsd !== undefined
      ? String(project.preferences.budgetLimitUsd)
      : "",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  const trueCapabilities = Object.entries(agent?.capabilities ?? {}).filter(
    ([key, value]) => value === true && key in capabilityLabels,
  );

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    try {
      const parsedLimit = budgetLimit.trim() ? Number(budgetLimit) : undefined;
      const response = await fetch(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          qualityPreference: quality,
          executionModePreference: executionMode,
          budgetMode,
          ...(parsedLimit !== undefined ? { budgetLimitUsd: parsedLimit } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Cập nhật trả về ${response.status}`);
      await refresh();
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <Title2>MAF có thể</Title2>
          <ShieldCheckmark20Regular />
        </div>
        <Text className={styles.quiet} size={200}>
          Dựa trên agent đang hoạt động{agent ? `: ${agent.name}` : " — chưa xác định"}.
        </Text>
        {trueCapabilities.length ? (
          trueCapabilities.map(([key]) => (
            <div className={styles.capabilityRow} key={key}>
              <CheckmarkCircle20Regular primaryFill="#70b88b" />
              <Text size={200}>{capabilityLabels[key]}</Text>
            </div>
          ))
        ) : (
          <Text className={styles.quiet} size={200}>
            Chưa có agent nào đang hoạt động để xác định khả năng.
          </Text>
        )}
      </div>
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <Title2>Quyền tự chủ</Title2>
          <LockClosed20Regular />
        </div>
        <Text className={styles.quiet} size={200}>
          Đây là hành vi cố định của engine, không phải cài đặt có thể tắt — hiển thị để bạn biết
          ranh giới thật của quyền tự chủ.
        </Text>
        <Text weight="semibold" size={200}>
          MAF luôn tự động
        </Text>
        {alwaysAutomatic.map((item) => (
          <div className={styles.capabilityRow} key={item}>
            <CheckmarkCircle20Regular primaryFill="#70b88b" />
            <Text size={200}>{item}</Text>
          </div>
        ))}
        <Text weight="semibold" size={200} style={{ marginTop: 8 }}>
          Luôn cần phê duyệt bên ngoài
        </Text>
        {alwaysRequiresApproval.map((item) => (
          <div className={styles.capabilityRow} key={item}>
            <Circle20Regular />
            <Text size={200}>{item}</Text>
          </div>
        ))}
      </div>
      <div className={styles.panel}>
        <Title2>Mặc định cho tác vụ mới</Title2>
        <Text className={styles.quiet} size={200}>
          Áp dụng khi tạo tác vụ mới từ dự án này; có thể ghi đè từng tác vụ.
        </Text>
        <div className={styles.controlsGrid}>
          <Field label="Ưu tiên chất lượng">
            <Select onChange={(_event, data) => setQuality(data.value)} value={quality}>
              <option value="FAST">Nhanh</option>
              <option value="BALANCED">Cân bằng</option>
              <option value="HIGH">Cao</option>
              <option value="CRITICAL">Rất cao</option>
            </Select>
          </Field>
          <Field label="Chế độ thực thi">
            <Select
              onChange={(_event, data) => setExecutionMode(data.value as typeof executionMode)}
              value={executionMode}
            >
              <option value="AUTO">Tự động (theo tín hiệu có bằng chứng)</option>
              <option value="STRICT">{friendlyMode("STRICT")}</option>
              <option value="GUIDED">{friendlyMode("GUIDED")}</option>
              <option value="SOLO_NATIVE">{friendlyMode("SOLO_NATIVE")}</option>
            </Select>
          </Field>
          <Field
            hint="ADVISORY: chỉ cảnh báo khi vượt. HARD: chặn khi vượt."
            label="Chế độ ngân sách"
          >
            <Select
              onChange={(_event, data) => setBudgetMode(data.value as typeof budgetMode)}
              value={budgetMode}
            >
              <option value="ADVISORY">Khuyến nghị (ADVISORY)</option>
              <option value="HARD">Giới hạn cứng (HARD)</option>
            </Select>
          </Field>
          <Field
            hint="Để trống nếu không muốn đặt giới hạn."
            label="Giới hạn ngân sách mỗi tác vụ ($)"
          >
            <Input
              onChange={(_event, data) => setBudgetLimit(data.value)}
              placeholder="Không giới hạn"
              type="number"
              value={budgetLimit}
            />
          </Field>
        </div>
        <Text className={styles.quiet} size={200}>
          {qualityPreferenceDescription(quality)}
        </Text>
        {error ? (
          <MessageBar intent="error">
            <MessageBarBody>Không thể lưu cài đặt. {error}</MessageBarBody>
          </MessageBar>
        ) : null}
        {saved ? (
          <MessageBar intent="success">
            <MessageBarBody>Đã lưu mặc định cho dự án.</MessageBarBody>
          </MessageBar>
        ) : null}
        <Button
          appearance="primary"
          disabled={saving}
          onClick={() => void save()}
          style={{ justifySelf: "start" }}
        >
          {saving ? "Đang lưu" : "Lưu mặc định"}
        </Button>
      </div>
    </div>
  );
}
