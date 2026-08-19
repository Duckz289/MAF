import {
  Button,
  MessageBar,
  MessageBarBody,
  Text,
  Title2,
  makeStyles,
} from "@fluentui/react-components";
import {
  ArrowLeft20Regular,
  CheckmarkCircle20Regular,
  Circle20Regular,
  Clock20Regular,
  Code20Regular,
  Dismiss20Regular,
} from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { Navigate, Run } from "../types";
import { formatCost, formatDate, friendlyMode, translatedValue } from "../utils";
import { EmptyState } from "../components/EmptyState";
import { RunStatusBadge } from "../components/StatusBadge";

interface RunEvent {
  id: string;
  type: string;
  timestamp: string;
}

const useStyles = makeStyles({
  back: { marginBottom: "12px" },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "22px",
    marginBottom: "24px",
  },
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
  const [events, setEvents] = useState<RunEvent[]>([]);
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
  const currentIndex = phaseIndex(run);
  const phases = ["Hiểu kho mã", "Điều tra", "Triển khai", "Xác minh"];
  const needsAttention = run.state === "FAILED" || run.operationalStatus === "STUCK";
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
            <Text>{run.agent}</Text>
            <Text>{friendlyMode(run.executionMode)}</Text>
            <Text>{run.revision}</Text>
            <Text>{formatCost(run.cost.total)}</Text>
          </div>
        </div>
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
            : run.verificationState === "VERIFIED"
              ? "Tác vụ đã vượt qua xác minh và sẵn sàng bàn giao."
              : "Không cần thao tác lúc này. MAF sẽ chỉ bàn giao sau khi có kết quả xác minh."}
        </MessageBarBody>
      </MessageBar>
      <div className={styles.layout}>
        <div className={styles.column}>
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
          <section className={styles.section}>
            <Title2 className={styles.sectionTitle}>Xác minh</Title2>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {run.verificationState === "VERIFIED" ? (
                <CheckmarkCircle20Regular color="#77ba91" />
              ) : (
                <Clock20Regular color="#75a9f2" />
              )}
              <Text>
                {run.verificationState === "VERIFIED"
                  ? "Đã xác minh trước khi bàn giao"
                  : "Chưa có bàn giao đã xác minh"}
              </Text>
            </div>
            {run.error ? (
              <MessageBar intent="error">
                <MessageBarBody>
                  Tác vụ không hoàn tất xác minh.
                  <details>
                    <summary>Chi tiết kỹ thuật</summary>
                    {run.error}
                  </details>
                </MessageBarBody>
              </MessageBar>
            ) : null}
          </section>
        </div>
        <aside className={styles.column}>
          <section className={styles.section}>
            <Title2 className={styles.sectionTitle}>Hoạt động</Title2>
            {events.length ? (
              <div className={styles.activity}>
                {events
                  .slice(-8)
                  .reverse()
                  .map((event) => (
                    <div className={styles.event} key={event.id}>
                      <Text size={200}>{event.type}</Text>
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
                <Text>Runtime intelligence</Text>
              </div>
              <Text className={styles.quiet} size={200}>
                {run.modeExplanation.reason}
              </Text>
              <div className={styles.fact}>
                <Text className={styles.quiet} size={200}>
                  Execution mode (effective)
                </Text>
                <Text>{run.effectiveMode ?? run.executionMode}</Text>
              </div>
              {run.desiredMode && run.desiredMode !== run.effectiveMode ? (
                <div className={styles.fact}>
                  <Text className={styles.quiet} size={200}>
                    Desired mode (not yet enforced)
                  </Text>
                  <Text>
                    {run.desiredMode}
                    {run.modeExplanation.pendingEnforcement
                      ? ` — pending ${run.modeExplanation.pendingEnforcement.method}`
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
                <Text weight="semibold">Chuyển đổi chế độ</Text>
                {run.modeExplanation.timeline.length ? (
                  run.modeExplanation.timeline.map((transition) => (
                    <div className={styles.signal} key={`${transition.timestamp}-${transition.to}`}>
                      <Text size={200}>
                        {transition.from} sang {transition.to}
                        {transition.enforcement ? ` (${transition.enforcement})` : ""}
                      </Text>
                      <Text className={styles.quiet} size={200}>
                        {transition.reason}
                      </Text>
                    </div>
                  ))
                ) : (
                  <Text block className={styles.quiet} size={200}>
                    Chưa có chuyển đổi chế độ.
                  </Text>
                )}
              </div>
            </div>
          </details>
        </aside>
      </div>
    </>
  );
}
