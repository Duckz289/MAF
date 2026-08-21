import { Badge, Button, makeStyles, Text, Title2 } from "@fluentui/react-components";
import {
  ArrowRight20Regular,
  CheckmarkCircle20Regular,
  PauseCircle20Regular,
  QuestionCircle20Regular,
  ShieldError20Regular,
} from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import {
  failureClassificationLabel,
  mergeEligibilityLabel,
  mergeEligibilityTone,
  qualityDimensionLabel,
  qualityStateLabel,
} from "../status";
import type { DecisionItem, Navigate } from "../types";
import { formatCost, formatRelativeTime, readJson } from "../utils";

const useStyles = makeStyles({
  page: { display: "grid", gap: "16px" },
  card: {
    padding: "20px",
    border: "1px solid #293038",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "12px",
  },
  head: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" },
  kind: { display: "flex", alignItems: "center", gap: "9px" },
  quiet: { color: "#8d97a2" },
  warnings: { display: "grid", gap: "4px", marginTop: "2px" },
  warningRow: { display: "flex", gap: "8px", alignItems: "center", color: "#c9902f" },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "16px",
    marginTop: "4px",
    paddingTop: "12px",
    borderTop: "1px solid #22272c",
  },
  calm: {
    padding: "40px 28px",
    border: "1px solid #242a30",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    justifyItems: "center",
    gap: "10px",
    textAlign: "center",
    color: "#8d97a2",
  },
});

const kindCopy = (
  item: DecisionItem,
): {
  icon: React.ReactNode;
  title: string;
  detail: string;
  tone: "warning" | "danger" | "info";
} => {
  if (item.type === "RECOVERY")
    return {
      icon: <PauseCircle20Regular />,
      title: "Tạm dừng — cần quyết định khôi phục",
      detail: `${failureClassificationLabel(item.recoveryReason)}${item.recoveryDetail ? ` — ${item.recoveryDetail}` : ""}`,
      tone: "warning",
    };
  if (item.type === "ASSURANCE_BLOCKED")
    return {
      icon: <ShieldError20Regular />,
      title: "Bằng chứng xác minh chưa đủ để bàn giao",
      detail:
        "Một hoặc nhiều bước xác minh bắt buộc chưa đạt. Mở tác vụ để xem chi tiết từng bước.",
      tone: "warning",
    };
  if (item.type === "DELIVERY")
    return {
      icon:
        item.mergeEligibility === "BLOCKED" ? (
          <ShieldError20Regular />
        ) : (
          <CheckmarkCircle20Regular />
        ),
      title:
        item.mergeEligibility === "BLOCKED"
          ? "Bàn giao bị chặn — có cảnh báo chất lượng"
          : "Sẵn sàng bàn giao — chờ phê duyệt bên ngoài",
      detail:
        item.mergeEligibility === "BLOCKED"
          ? "MAF không tự merge. Xem lại các cảnh báo bên dưới trước khi quyết định."
          : "Candidate đã qua các bước xác minh bắt buộc. MAF không tự merge — cần bạn hoặc CI phê duyệt.",
      tone: item.mergeEligibility === "BLOCKED" ? "danger" : "info",
    };
  return {
    icon: <QuestionCircle20Regular />,
    title: "Chờ đánh giá độc lập",
    detail: "Kết quả xác minh cần một lượt đánh giá độc lập trước khi có thể bàn giao.",
    tone: "info",
  };
};

function DecisionCard({ item, navigate }: { item: DecisionItem; navigate: Navigate }) {
  const styles = useStyles();
  const copy = kindCopy(item);
  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div className={styles.kind}>
          {copy.icon}
          <div>
            <Text weight="semibold">{copy.title}</Text>
            <Text block className={styles.quiet} size={200}>
              {item.task}
            </Text>
          </div>
        </div>
        {item.type === "DELIVERY" ? (
          <Badge appearance="tint" color={mergeEligibilityTone(item.mergeEligibility)}>
            {mergeEligibilityLabel(item.mergeEligibility)}
          </Badge>
        ) : null}
      </div>
      <Text size={200}>{copy.detail}</Text>
      {item.type === "RECOVERY" ? (
        <Text className={styles.quiet} size={200}>
          Chi phí đã dùng: {formatCost(item.costSpent)} · Ngân sách còn lại:{" "}
          {item.remainingBudget === null ? "Chưa rõ" : formatCost(item.remainingBudget)}
        </Text>
      ) : null}
      {item.type === "DELIVERY" && item.knownWarnings.length ? (
        <div className={styles.warnings}>
          {item.knownWarnings.map((warning) => (
            <div className={styles.warningRow} key={warning.dimension}>
              <Text size={200}>
                {qualityDimensionLabel(warning.dimension)}: {qualityStateLabel(warning.state)}
              </Text>
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.footer}>
        <Text className={styles.quiet} size={100}>
          Cập nhật {formatRelativeTime(item.updatedAt)}
        </Text>
        <Button
          appearance="secondary"
          icon={<ArrowRight20Regular />}
          iconPosition="after"
          onClick={() => navigate(`/runs/${item.runId}`)}
        >
          Mở tác vụ
        </Button>
      </div>
    </article>
  );
}

export function DecisionsPage({ navigate }: { navigate: Navigate }) {
  const styles = useStyles();
  const [items, setItems] = useState<DecisionItem[]>();
  useEffect(() => {
    void readJson<DecisionItem[]>("/api/v1/decisions")
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  return (
    <div className={styles.page}>
      <PageHeader
        description="Chỉ những việc thực sự cần bạn quyết định mới xuất hiện ở đây — mọi thứ khác MAF tự xử lý."
        title="Quyết định"
      />
      {items === undefined ? null : items.length ? (
        items
          .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .map((item) => (
            <DecisionCard item={item} key={`${item.type}-${item.runId}`} navigate={navigate} />
          ))
      ) : (
        <div className={styles.calm}>
          <CheckmarkCircle20Regular fontSize={26} />
          <Title2>Không có việc nào cần bạn xử lý</Title2>
          <Text className={styles.quiet}>
            MAF sẽ đưa lên đây khi có việc thực sự cần quyết định của bạn — ví dụ khôi phục sau khi
            tạm dừng, hoặc bàn giao có cảnh báo chất lượng.
          </Text>
        </div>
      )}
    </div>
  );
}
