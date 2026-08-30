import { Button, MessageBar, MessageBarBody, makeStyles, Text } from "@fluentui/react-components";
import {
  ArrowRight20Regular,
  Bot20Regular,
  Key20Regular,
  Play20Regular,
  Settings20Regular,
} from "@fluentui/react-icons";
import { connectionStatusLabel } from "../presentation";
import type { Connection, ConnectionTestResult } from "../types";
import { formatDate } from "../utils";
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
  configureActionLabel,
  onDisconnect,
  onPrimaryAction,
  onTest,
  primaryActionDisabled,
  primaryActionLabel,
  result,
}: {
  checking?: boolean | undefined;
  connection: Connection;
  onConfigure?: (() => void) | undefined;
  configureActionLabel?: string | undefined;
  onDisconnect?: (() => void) | undefined;
  onPrimaryAction?: (() => void) | undefined;
  onTest?: (() => void) | undefined;
  primaryActionDisabled?: boolean | undefined;
  primaryActionLabel?: string | undefined;
  result?: ConnectionTestResult | undefined;
}) {
  const styles = useStyles();
  const accountAgent = connection.category === "ACCOUNT_AGENT";
  const status = result?.status ?? connection.status;
  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div className={styles.identity}>
          <span className={styles.mark} aria-hidden="true">
            {accountAgent ? <Bot20Regular /> : <Key20Regular />}
          </span>
          <div className={styles.name}>
            <Text size={400} weight="semibold">
              {connection.provider}
            </Text>
            <Text size={200} style={{ color: "#8d97a2" }}>
              {accountAgent
                ? connection.method === "NATIVE_SESSION"
                  ? "Tài khoản và agent CLI native"
                  : "Tài khoản provider"
                : "API provider"}
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
          {accountAgent
            ? (connection.authentication ??
              (connection.method === "OAUTH_PKCE" ? "OAuth provider" : "Phiên native"))
            : "API key"}
        </Text>
        {connection.account ? (
          <>
            <Text className={styles.label} size={200}>
              Tài khoản
            </Text>
            <Text className={styles.value} size={200}>
              {connection.account.email}
              {connection.account.planType
                ? ` · ${formatPlanType(connection.account.planType)}`
                : ""}
            </Text>
          </>
        ) : null}
        <Text className={styles.label} size={200}>
          Khả năng
        </Text>
        <Text className={styles.value} size={200}>
          {connection.capability}
        </Text>
        {connection.protocol ? (
          <>
            <Text className={styles.label} size={200}>
              Protocol
            </Text>
            <Text className={styles.value} size={200}>
              {connection.protocol === "OPENAI_COMPATIBLE"
                ? "OpenAI Compatible"
                : "Anthropic Compatible"}
            </Text>
          </>
        ) : null}
        {connection.baseUrl ? (
          <>
            <Text className={styles.label} size={200}>
              Endpoint
            </Text>
            <Text className={styles.value} size={200}>
              {connection.baseUrl}
            </Text>
          </>
        ) : null}
        {connection.defaultModel ? (
          <>
            <Text className={styles.label} size={200}>
              Model mặc định
            </Text>
            <Text className={styles.value} size={200}>
              {connection.defaultModel}
            </Text>
          </>
        ) : null}
        <Text className={styles.label} size={200}>
          MAF lưu trữ
        </Text>
        <Text className={styles.value} size={200}>
          {accountAgent
            ? "Chỉ trạng thái; email/gói chỉ được đọc trực tiếp khi tải trang"
            : (connection.credentialReference ?? "Không lưu API key thô")}
        </Text>
      </div>
      <Text className={styles.note} size={200}>
        {connection.detail}
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
        {onDisconnect ? (
          <Button appearance="subtle" onClick={onDisconnect}>
            {accountAgent ? "Ngắt khỏi MAF" : "Ngắt kết nối"}
          </Button>
        ) : null}
        {onTest ? (
          <Button
            appearance="secondary"
            disabled={Boolean(checking)}
            icon={<Play20Regular />}
            onClick={onTest}
          >
            {checking
              ? "Đang kiểm tra"
              : result
                ? "Kiểm tra lại"
                : accountAgent
                  ? "Kiểm tra trạng thái"
                  : "Kiểm tra kết nối"}
          </Button>
        ) : null}
        {onPrimaryAction ? (
          <Button
            appearance="primary"
            icon={<ArrowRight20Regular />}
            onClick={onPrimaryAction}
            {...(primaryActionDisabled === undefined ? {} : { disabled: primaryActionDisabled })}
          >
            {primaryActionLabel ?? "Cấu hình"}
          </Button>
        ) : null}
        {onConfigure ? (
          <Button appearance="primary" icon={<Settings20Regular />} onClick={onConfigure}>
            {configureActionLabel ?? "Cấu hình"}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function formatPlanType(planType: string): string {
  const labels: Record<string, string> = {
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    free: "ChatGPT Free",
  };
  return labels[planType.toLowerCase()] ?? planType;
}
