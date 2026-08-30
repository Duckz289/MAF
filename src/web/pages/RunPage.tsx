import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  Text,
  Title2,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  ArrowSync20Regular,
  CheckmarkCircle20Regular,
  Circle20Regular,
  Clock20Regular,
  Code20Regular,
  Dismiss20Regular,
  PauseCircle20Regular,
  ShieldError20Regular,
} from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { RunStatusBadge } from "../components/StatusBadge";
import {
  eventTypeLabel,
  failureClassificationLabel,
  mergeEligibilityLabel,
  mergeEligibilityTone,
  primaryQualityDimensions,
  qualityDimensionLabel,
  qualityStateLabel,
  qualityStateTone,
  riskDimensionLabel,
  riskLevelLabel,
  riskLevelTone,
  riskProvenanceNote,
  trustStateLabel,
  trustStateTone,
} from "../status";
import type { DeliveryDecision, Navigate, RecoveryCapsule, Run } from "../types";
import { formatCost, formatDate, friendlyMode, readJson, translatedValue } from "../utils";

interface RunEvent {
  id: string;
  type: string;
  timestamp: string;
  data?: unknown;
}

interface BudgetAllocatedData {
  mode: "ADVISORY" | "HARD";
  configured: boolean;
  allocation: { execution: number; verification: number; recovery: number; total: number } | null;
}

interface CostEstimatedData {
  estimate: { low: number; high: number; confidence: string; basis: string } | null;
}

interface QualityAssessedData {
  report?: Record<string, { state: string; evidence: string[] }>;
  trustState?: string;
  review?: { status: string; reasons: string[] };
  reviewSkipped?: string;
}

interface RiskProfiledData {
  stage: "pre-execution" | "diff-captured";
  riskVector?: Record<string, { level: string; provenance: string; evidence: string[] }>;
}

interface AssurancePlannedData {
  stage: "pre-execution" | "diff-captured";
  plan?: { required: string[]; notRequired: string[]; reasons: Record<string, string> };
}

/** AssuranceCheck -> QualityDimension it gates, per src/domain/quality.ts gatedDimensions. */
const gatingCheckByDimension: Record<string, string> = {
  Correctness: "CORRECTNESS",
  Architecture: "ARCHITECTURE",
  DebtDelta: "DEBT",
  Security: "SECURITY",
  Performance: "PERFORMANCE",
  Resilience: "RESILIENCE",
};

const useStyles = makeStyles({
  back: { marginBottom: "12px" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "22px",
    marginBottom: "24px",
  },
  headerActions: { display: "flex", gap: "8px" },
  headerCopy: { minWidth: 0, display: "grid", gap: "10px" },
  title: { fontSize: "30px", lineHeight: "38px", letterSpacing: "-.025em" },
  metadata: { display: "flex", gap: "9px 16px", flexWrap: "wrap", color: "#8d97a2" },
  progress: {
    padding: "20px 22px",
    border: "1px solid #293038",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: "8px",
    marginBottom: "20px",
    "@media (max-width: 760px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
  },
  progressItem: {
    position: "relative",
    minHeight: "52px",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    color: "#7f8a96",
  },
  progressDone: { color: "#77ba91" },
  progressCurrent: { color: "#75a9f2" },
  notice: { marginBottom: "22px" },
  layout: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.35fr) minmax(290px, .65fr)",
    gap: "20px",
    alignItems: "start",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  column: { minWidth: 0, display: "grid", gap: "18px" },
  section: {
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "14px",
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
  },
  sectionTitle: { fontSize: "19px", lineHeight: "26px" },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "18px",
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  fact: { display: "grid", gap: "4px" },
  quiet: { color: "#7f8a96" },
  fileList: { display: "grid", gap: "3px" },
  file: {
    padding: "8px 10px",
    borderRadius: "6px",
    color: "#b6bec7",
    fontFamily: '"Cascadia Code", Consolas, monospace',
    backgroundColor: "#15181b",
    overflowWrap: "anywhere",
  },
  activity: { display: "grid", gap: "2px" },
  event: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "14px",
    padding: "9px 0",
    borderBottom: "1px solid #22272c",
  },
  advanced: {
    padding: "18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#0f1113",
  },
  advancedBody: { display: "grid", gap: "16px", paddingTop: "16px" },
  signal: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "12px",
    padding: "7px 0",
  },
  checkRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "10px",
    alignItems: "start",
    padding: "8px 0",
    borderBottom: "1px solid #1c2126",
  },
  checkEvidence: { color: "#7f8a96" },
  toggle: { justifySelf: "start" },
  riskRow: { display: "grid", gap: "3px", padding: "8px 0", borderBottom: "1px solid #1c2126" },
  warningList: { display: "grid", gap: "6px" },
  costGrid: { display: "grid", gap: "6px" },
});

const phaseIndex = (run: Run) => {
  if (run.verificationState === "VERIFIED") return 5;
  if (run.currentPhase === "Verification") return 3;
  if (run.state === "RUNNING") return 2;
  if (run.state === "QUEUED") return 1;
  return run.changedFiles.length ? 3 : 2;
};

export function RunPage({
  navigate,
  refresh,
  run,
}: {
  navigate: Navigate;
  refresh: () => Promise<void>;
  run?: Run | undefined;
}) {
  const styles = useStyles();
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);
  const [showAllRisk, setShowAllRisk] = useState(false);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [capsule, setCapsule] = useState<RecoveryCapsule>();
  const [delivery, setDelivery] = useState<DeliveryDecision>();

  useEffect(() => {
    if (!run) return;
    void fetch(`/api/v1/runs/${run.id}/events?follow=false`)
      .then((response) => response.text())
      .then((body) => {
        const parsed = body
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as RunEvent);
        setEvents(parsed);
      })
      .catch(() => setEvents([]));
  }, [run]);

  useEffect(() => {
    if (!run || run.state !== "PAUSED") {
      setCapsule(undefined);
      return;
    }
    void readJson<RecoveryCapsule>(`/api/v1/runs/${run.id}/recovery-capsule`)
      .then(setCapsule)
      .catch(() => setCapsule(undefined));
  }, [run]);

  useEffect(() => {
    if (!run || run.state !== "COMPLETED" || run.verificationState !== "VERIFIED") {
      setDelivery(undefined);
      return;
    }
    void readJson<DeliveryDecision>(`/api/v1/runs/${run.id}/delivery`)
      .then(setDelivery)
      .catch(() => setDelivery(undefined));
  }, [run]);

  const budgetAllocated = events.find((event) => event.type === "BudgetAllocated")?.data as
    | BudgetAllocatedData
    | undefined;
  const costEstimated = events.find((event) => event.type === "CostEstimated")?.data as
    | CostEstimatedData
    | undefined;
  const quality = events.filter((event) => event.type === "QualityAssessed").at(-1)?.data as
    | QualityAssessedData
    | undefined;
  const risk = useMemo(() => {
    const riskEvents = events.filter((event) => event.type === "RiskProfiled");
    const preferred =
      riskEvents.findLast((event) => (event.data as RiskProfiledData)?.stage === "diff-captured") ??
      riskEvents.at(-1);
    return preferred?.data as RiskProfiledData | undefined;
  }, [events]);
  const assurancePlan = useMemo(() => {
    const planEvents = events.filter((event) => event.type === "AssurancePlanned");
    const preferred =
      planEvents.findLast(
        (event) => (event.data as AssurancePlannedData)?.stage === "diff-captured",
      ) ?? planEvents.at(-1);
    return (preferred?.data as AssurancePlannedData | undefined)?.plan;
  }, [events]);

  if (!run)
    return (
      <EmptyState
        actionLabel="Quay lại tác vụ"
        description="Tác vụ này không tồn tại hoặc chưa được tải."
        onAction={() => navigate("/runs")}
        title="Không tìm thấy tác vụ"
      />
    );

  const cancel = async () => {
    setCancelling(true);
    try {
      await fetch(`/api/v1/runs/${run.id}/cancel`, { method: "POST" });
      await refresh();
    } finally {
      setCancelling(false);
    }
  };
  const resume = async () => {
    setResuming(true);
    try {
      const response = await fetch(`/api/v1/runs/${run.id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.ok) await refresh();
    } finally {
      setResuming(false);
    }
  };

  const currentIndex = phaseIndex(run);
  const phases = ["Hiểu kho mã", "Điều tra", "Triển khai", "Xác minh"];
  const needsAttention =
    run.state === "FAILED" || run.state === "PAUSED" || run.operationalStatus === "STUCK";
  const reviewRequired = Boolean(assurancePlan?.required.includes("INDEPENDENT_REVIEW"));
  const trustHeadline = trustStateLabel(run.trustState, reviewRequired);
  const trustTone = trustStateTone(run.trustState);

  const report = quality?.report ?? {};
  const reportEntries = Object.entries(report);
  const requiredDimensions = new Set(
    reportEntries
      .filter(([dimension]) => {
        const check = gatingCheckByDimension[dimension];
        return check !== undefined && assurancePlan?.required.includes(check);
      })
      .map(([dimension]) => dimension),
  );
  const visibleChecks = reportEntries.filter(
    ([dimension, result]) =>
      showAllChecks ||
      primaryQualityDimensions.includes(dimension as (typeof primaryQualityDimensions)[number]) ||
      requiredDimensions.has(dimension) ||
      (result.state !== "PASS" && result.state !== "NOT_REQUIRED"),
  );

  const riskVector = risk?.riskVector ?? {};
  const riskEntries = Object.entries(riskVector);
  const aggregateRiskLevel = riskEntries.some(([, value]) => value.level === "HIGH")
    ? "HIGH"
    : riskEntries.some(([, value]) => value.level === "MEDIUM")
      ? "MEDIUM"
      : riskEntries.length
        ? "LOW"
        : undefined;
  const notableRisk = riskEntries.filter(([, value]) => value.level !== "LOW");
  const visibleRisk = showAllRisk ? riskEntries : notableRisk;

  const costBreakdown = [
    { label: "Model", value: run.cost.model },
    { label: "Sandbox", value: run.cost.sandbox },
    { label: "Xác minh", value: run.cost.verification },
    { label: "Thử lại", value: run.cost.retry },
    { label: "Khôi phục", value: run.cost.recovery },
  ].filter((entry) => typeof entry.value === "number" && entry.value > 0);

  return (
    <>
      <Button
        className={styles.back}
        appearance="subtle"
        icon={<ArrowLeft20Regular />}
        onClick={() => navigate("/runs")}
      >
        Tất cả tác vụ
      </Button>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <Text as="h1" className={styles.title} weight="semibold">
            {run.task}
          </Text>
          <div className={styles.metadata}>
            <RunStatusBadge run={run} />
            <Badge appearance="tint" color={trustTone}>
              {trustHeadline}
            </Badge>
            <Text>{run.agent}</Text>
            <Text>{friendlyMode(run.executionMode)}</Text>
            <Text>{run.revision}</Text>
            <Text>{formatCost(run.cost.total)}</Text>
          </div>
        </div>
        <div className={styles.headerActions}>
          {run.state === "PAUSED" ? (
            <Button
              appearance="primary"
              disabled={resuming}
              icon={<ArrowSync20Regular />}
              onClick={() => void resume()}
            >
              {resuming ? "Đang tiếp tục" : "Tiếp tục tác vụ"}
            </Button>
          ) : null}
          {run.state === "RUNNING" || run.state === "QUEUED" ? (
            <Button
              appearance="secondary"
              disabled={cancelling}
              icon={<Dismiss20Regular />}
              onClick={() => void cancel()}
            >
              {cancelling ? "Đang hủy" : "Hủy tác vụ"}
            </Button>
          ) : null}
        </div>
      </header>
      <section className={styles.progress} aria-label="Tiến độ tác vụ">
        {phases.map((label, index) => {
          const step = index + 1;
          const done = currentIndex > step;
          const current = currentIndex === step && run.state !== "FAILED";
          return (
            <div
              className={`${styles.progressItem} ${done ? styles.progressDone : ""} ${current ? styles.progressCurrent : ""}`}
              key={label}
            >
              {done ? (
                <CheckmarkCircle20Regular />
              ) : current ? (
                <Clock20Regular />
              ) : (
                <Circle20Regular />
              )}
              <Text size={200}>{label}</Text>
            </div>
          );
        })}
      </section>
      <MessageBar className={styles.notice} intent={needsAttention ? "error" : "info"}>
        <MessageBarBody>
          {needsAttention
            ? "Tác vụ cần bạn xem lại. Mở chi tiết lỗi bên dưới để xác định bước tiếp theo."
            : trustHeadline}
        </MessageBarBody>
      </MessageBar>
      <div className={styles.layout}>
        <div className={styles.column}>
          {run.state === "PAUSED" ? (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <Title2 className={styles.sectionTitle}>Khôi phục</Title2>
                <PauseCircle20Regular />
              </div>
              <Text size={200}>
                {failureClassificationLabel(capsule?.recoveryReason)}
                {capsule?.recoveryDetail ? ` — ${capsule.recoveryDetail}` : ""}
              </Text>
              <div className={styles.summaryGrid}>
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Công việc đã lưu
                  </Text>
                  <Text>Đã bảo toàn — có thể tiếp tục từ trạng thái này</Text>
                </div>
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Ngân sách còn lại
                  </Text>
                  <Text>
                    {capsule?.remainingBudget === null || capsule?.remainingBudget === undefined
                      ? "Chưa rõ"
                      : formatCost(capsule.remainingBudget)}
                  </Text>
                </div>
              </div>
              {capsule?.verifiedFacts.length ? (
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Đã xác minh trước khi dừng
                  </Text>
                  {capsule.verifiedFacts.map((fact) => (
                    <Text block key={fact} size={200}>
                      • {fact}
                    </Text>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          <section className={styles.section}>
            <Title2 className={styles.sectionTitle}>Tóm tắt</Title2>
            <div className={styles.summaryGrid}>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Giai đoạn hiện tại
                </Text>
                <Text>{translatedValue(run.currentPhase)}</Text>
              </div>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Kết quả xác minh
                </Text>
                <Text>{translatedValue(run.verificationState)}</Text>
              </div>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Kho mã
                </Text>
                <Text>{run.repositoryPath || "Không khả dụng"}</Text>
              </div>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Cập nhật
                </Text>
                <Text>{formatDate(run.updatedAt)}</Text>
              </div>
            </div>
          </section>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <Title2 className={styles.sectionTitle}>Xác minh</Title2>
              {reportEntries.length ? (
                <Button
                  appearance="subtle"
                  size="small"
                  onClick={() => setShowAllChecks((value) => !value)}
                >
                  {showAllChecks
                    ? "Chỉ hiện quan trọng"
                    : `Xem tất cả ${reportEntries.length} khía cạnh`}
                </Button>
              ) : null}
            </div>
            {reportEntries.length ? (
              visibleChecks.map(([dimension, result]) => (
                <div className={styles.checkRow} key={dimension}>
                  <div>
                    <Text>{qualityDimensionLabel(dimension)}</Text>
                    {result.evidence[0] ? (
                      <Text block className={styles.checkEvidence} size={100}>
                        {result.evidence[0]}
                      </Text>
                    ) : null}
                  </div>
                  <Badge appearance="tint" color={qualityStateTone(result.state)}>
                    {qualityStateLabel(result.state)}
                  </Badge>
                </div>
              ))
            ) : (
              <Text className={styles.quiet}>
                {run.verificationState === "VERIFIED"
                  ? "Đã xác minh tính đúng đắn trước khi bàn giao."
                  : "Chưa có bàn giao đã xác minh."}
              </Text>
            )}
            {quality?.reviewSkipped ? (
              <Text className={styles.quiet} size={200}>
                Bỏ qua đánh giá độc lập: {quality.reviewSkipped}
              </Text>
            ) : quality?.review ? (
              <Text size={200}>
                Đánh giá độc lập:{" "}
                {quality.review.status === "APPROVED" ? "Đã chấp thuận" : "Chưa chấp thuận"}
              </Text>
            ) : null}
            {run.error ? (
              <MessageBar intent={run.state === "PAUSED" ? "warning" : "error"}>
                <MessageBarBody>
                  {run.state === "PAUSED"
                    ? "Tác vụ đã tạm dừng an toàn — trạng thái khôi phục đã được lưu và có thể tiếp tục."
                    : "Tác vụ không hoàn tất xác minh."}
                  <details>
                    <summary>Chi tiết kỹ thuật</summary>
                    {run.error}
                  </details>
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </section>
          {riskEntries.length ? (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <Title2 className={styles.sectionTitle}>Rủi ro</Title2>
                <Badge appearance="tint" color={riskLevelTone(aggregateRiskLevel)}>
                  {riskLevelLabel(aggregateRiskLevel)}
                </Badge>
              </div>
              {notableRisk.length ? (
                <Text className={styles.quiet} size={200}>
                  MAF đã điều chỉnh mức xác minh dựa trên các yếu tố dưới đây.
                </Text>
              ) : (
                <Text className={styles.quiet} size={200}>
                  Không có yếu tố rủi ro đáng chú ý trong thay đổi này.
                </Text>
              )}
              {visibleRisk.map(([dimension, value]) => (
                <div className={styles.riskRow} key={dimension}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <Text size={200}>{riskDimensionLabel(dimension)}</Text>
                    <Badge appearance="tint" color={riskLevelTone(value.level)} size="small">
                      {riskLevelLabel(value.level)}
                    </Badge>
                  </div>
                  <Text className={styles.quiet} size={100}>
                    {riskProvenanceNote(value.provenance) ?? value.evidence[0]}
                  </Text>
                </div>
              ))}
              {riskEntries.length > notableRisk.length ? (
                <Button
                  appearance="subtle"
                  className={styles.toggle}
                  size="small"
                  onClick={() => setShowAllRisk((value) => !value)}
                >
                  {showAllRisk
                    ? "Chỉ hiện yếu tố đáng chú ý"
                    : `Xem chi tiết cả ${riskEntries.length} yếu tố`}
                </Button>
              ) : null}
            </section>
          ) : null}
          {delivery ? (
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <Title2 className={styles.sectionTitle}>Bàn giao</Title2>
                <Badge appearance="tint" color={mergeEligibilityTone(delivery.mergeEligibility)}>
                  {mergeEligibilityLabel(delivery.mergeEligibility)}
                </Badge>
              </div>
              <Text size={200}>
                MAF không tự merge — bàn giao luôn cần phê duyệt bên ngoài (CI hoặc con người).
              </Text>
              {delivery.handoff.knownWarnings.length ? (
                <div className={styles.warningList}>
                  {delivery.handoff.knownWarnings.map((warning) => (
                    <div className={styles.checkRow} key={warning.dimension}>
                      <Text size={200}>{qualityDimensionLabel(warning.dimension)}</Text>
                      <Badge appearance="tint" color={qualityStateTone(warning.state)} size="small">
                        {qualityStateLabel(warning.state)}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          <section className={styles.section}>
            <Title2 className={styles.sectionTitle}>Thay đổi</Title2>
            {run.changedFiles.length ? (
              <div className={styles.fileList}>
                {run.changedFiles.map((file) => (
                  <Text className={styles.file} key={file}>
                    {file}
                  </Text>
                ))}
              </div>
            ) : (
              <Text className={styles.quiet}>Chưa ghi nhận tệp thay đổi.</Text>
            )}
          </section>
        </div>
        <aside className={styles.column}>
          {costBreakdown.length ? (
            <section className={styles.section}>
              <Title2 className={styles.sectionTitle}>Chi phí</Title2>
              <div className={styles.costGrid}>
                {costBreakdown.map((entry) => (
                  <div className={styles.signal} key={entry.label}>
                    <Text size={200}>{entry.label}</Text>
                    <Text size={200}>{formatCost(entry.value ?? 0)}</Text>
                  </div>
                ))}
                <div className={styles.signal}>
                  <Text weight="semibold" size={200}>
                    Tổng
                  </Text>
                  <Text weight="semibold" size={200}>
                    {formatCost(run.cost.total)}
                  </Text>
                </div>
              </div>
            </section>
          ) : null}
          <section className={styles.section}>
            <Title2 className={styles.sectionTitle}>Hoạt động</Title2>
            {events.length ? (
              <div className={styles.activity}>
                {events
                  .slice(-8)
                  .reverse()
                  .map((event) => (
                    <div className={styles.event} key={event.id}>
                      <Text size={200}>{eventTypeLabel(event.type)}</Text>
                      <Text className={styles.quiet} size={100}>
                        {formatDate(event.timestamp)}
                      </Text>
                    </div>
                  ))}
              </div>
            ) : (
              <Text className={styles.quiet}>Chưa có sự kiện hoạt động.</Text>
            )}
          </section>
          <details className={styles.advanced}>
            <summary>
              <Text weight="semibold">Nâng cao</Text>
            </summary>
            <div className={styles.advancedBody}>
              <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                <Code20Regular />
                <Text>Điều chỉnh mức độ giám sát</Text>
              </div>
              <Text className={styles.quiet} size={200}>
                {run.modeExplanation.reason}
              </Text>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Chế độ đang áp dụng
                </Text>
                <Text>{friendlyMode(run.effectiveMode ?? run.executionMode)}</Text>
              </div>
              {run.desiredMode && run.desiredMode !== run.effectiveMode ? (
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Chế độ mong muốn (chưa áp dụng)
                  </Text>
                  <Text>
                    {friendlyMode(run.desiredMode)}
                    {run.modeExplanation.pendingEnforcement
                      ? ` — chờ ${run.modeExplanation.pendingEnforcement.method}`
                      : ""}
                  </Text>
                </div>
              ) : null}
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Snapshot ID
                </Text>
                <Text>{run.modeExplanation.latestSnapshotId ?? "Chưa có snapshot"}</Text>
              </div>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Ngân sách
                </Text>
                <Text>
                  {!budgetAllocated || !budgetAllocated.configured
                    ? "Chưa cấu hình (không giới hạn)"
                    : budgetAllocated.mode === "HARD"
                      ? `Giới hạn cứng — ${formatCost(budgetAllocated.allocation?.total ?? 0)}`
                      : `Khuyến nghị — ${formatCost(budgetAllocated.allocation?.total ?? 0)}`}
                </Text>
              </div>
              {costEstimated?.estimate ? (
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Ước tính chi phí ({costEstimated.estimate.confidence})
                  </Text>
                  <Text>
                    {formatCost(costEstimated.estimate.low)} –{" "}
                    {formatCost(costEstimated.estimate.high)}
                  </Text>
                </div>
              ) : (
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Ước tính chi phí
                  </Text>
                  <Text>Chưa đủ dữ liệu lịch sử</Text>
                </div>
              )}
              <div>
                <Text weight="semibold">Tín hiệu runtime</Text>
                {Object.entries(run.modeExplanation.latestSignals).length ? (
                  Object.entries(run.modeExplanation.latestSignals).map(([name, signal]) => (
                    <div className={styles.signal} key={name}>
                      <Text size={200}>{name}</Text>
                      <Text className={styles.quiet} size={200}>
                        {String(signal.value)} ({signal.reliability})
                      </Text>
                    </div>
                  ))
                ) : (
                  <Text block className={styles.quiet} size={200}>
                    Chưa có tín hiệu được ghi nhận.
                  </Text>
                )}
              </div>
              <div>
                <Text weight="semibold">Lịch sử điều chỉnh giám sát</Text>
                {run.modeExplanation.timeline.length ? (
                  run.modeExplanation.timeline.map((transition) => (
                    <div className={styles.signal} key={`${transition.timestamp}-${transition.to}`}>
                      <Text size={200}>
                        {friendlyMode(transition.from as Run["executionMode"])} sang{" "}
                        {friendlyMode(transition.to as Run["executionMode"])}
                        {transition.enforcement ? ` (${transition.enforcement})` : ""}
                      </Text>
                      <Text className={styles.quiet} size={200}>
                        {transition.reason}
                      </Text>
                    </div>
                  ))
                ) : (
                  <Text block className={styles.quiet} size={200}>
                    Chưa có điều chỉnh nào.
                  </Text>
                )}
              </div>
              {run.error && capsule === undefined && run.state !== "PAUSED" ? (
                <div style={{ display: "flex", gap: 9, alignItems: "center" }}>
                  <ShieldError20Regular />
                  <Text size={200}>Xem chi tiết lỗi trong phần Xác minh ở trên.</Text>
                </div>
              ) : null}
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}
