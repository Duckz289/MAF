import { Button, MessageBar, MessageBarBody, Text, makeStyles } from "@fluentui/react-components";
import {
  Bot20Regular,
  Key20Regular,
  Play20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import type { Connection, ConnectionTestResult } from "../types";
import { formatDate } from "../utils";
import { connectionStatusLabel } from "../presentation";
import { StatusBadge } from "./StatusBadge";

const useStyles = makeStyles({
  card: {
    minHeight: "300px",
    padding: "20px",
    border: "1px solid #293038",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "flex",
    flexDirection: "column",
    gap: "17px",
  },
  head: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "14px" },
  identity: { display: "flex", alignItems: "center", gap: "12px" },
  mark: {
    width: "38px",
    height: "38px",
    borderRadius: "10px",
    backgroundColor: "#1a222b",
    color: "#75a9f2",
    display: "grid",
    placeItems: "center",
  },
  name: { display: "grid", gap: "2px" },
  facts: {
    display: "grid",
    gridTemplateColumns: "128px minmax(0, 1fr)",
    gap: "10px 14px",
    "@media (max-width: 520px)": { gridTemplateColumns: "1fr", gap: "3px" },
  },
  label: { color: "#7f8a96" },
  value: { overflowWrap: "anywhere" },
  actions: {
    marginTop: "auto",
    paddingTop: "14px",
    borderTop: "1px solid #252b31",
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    flexWrap: "wrap",
  },
  note: { color: "#8d97a2", lineHeight: "20px" },
});

export function ProviderCard({
  checking,
  connection,
  onConfigure,
  onTest,
  result,
}: {
  checking?: boolean | undefined;
  connection: Connection;
  onConfigure?: (() => void) | undefined;
  onTest?: (() => void) | undefined;
  result?: ConnectionTestResult | undefined;
}) {
  const styles = useStyles();
  const native = connection.method === "NATIVE_SESSION";
  const status = result?.status ?? connection.status;
  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.mark} aria-hidden="true">
            {native ? <Bot20Regular /> : <Key20Regular />}
          </span>
          <div className={styles.name}>
            <Text size={400} weight="semibold">
              {connection.provider}
            </Text>
            <Text size={200} style={{ color: "#8d97a2" }}>
              {native ? "Agent CLI native" : "Thực thi qua API"}
            </Text>
          </div>
        </div>
        <StatusBadge
          {...(connectionStatusLabel(status, Boolean(result))
            ? { label: connectionStatusLabel(status, Boolean(result)) }
            : {})}
          status={status}
        />
      </div>
      <div className={styles.facts}>
        <Text className={styles.label} size={200}>
          Xác thực
        </Text>
        <Text className={styles.value} size={200}>
          {native ? "Do phiên Claude Code quản lý" : "Tham chiếu credential"}
        </Text>
        <Text className={styles.label} size={200}>
          Khả năng
        </Text>
        <Text className={styles.value} size={200}>
          {connection.capability}
        </Text>
        <Text className={styles.label} size={200}>
          MAF lưu trữ
        </Text>
        <Text className={styles.value} size={200}>
          {native
            ? "Không lưu OAuth token"
            : (connection.credentialReference ?? "Không lưu API key thô")}
        </Text>
      </div>
      <Text className={styles.note} size={200}>
        {native
          ? "MAF dùng phiên đăng nhập native sẵn có của Claude Code."
          : "Kho bí mật an toàn và executor OpenAI chưa có trong bản dựng này."}
      </Text>
      {result ? (
        <MessageBar intent={result.status === "UNAVAILABLE" ? "warning" : "info"}>
          <MessageBarBody>
            {result.detail ?? result.message ?? "Đã kiểm tra kết nối."}
            {result.lastCheckedAt ? (
              <Text block size={100}>
                Kiểm tra lúc {formatDate(result.lastCheckedAt)}
              </Text>
            ) : null}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      <div className={styles.actions}>
        {onTest ? (
          <Button
            appearance="secondary"
            disabled={Boolean(checking)}
            icon={<Play20Regular />}
            onClick={onTest}
          >
            {checking ? "Đang kiểm tra" : result ? "Kiểm tra lại" : "Kiểm tra kết nối"}
          </Button>
        ) : null}
        {onConfigure ? (
          <Button appearance="primary" icon={<Settings20Regular />} onClick={onConfigure}>
            Cấu hình
          </Button>
        ) : null}
      </div>
    </article>
  );
}
