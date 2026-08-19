import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Radio,
  RadioGroup,
  Tab,
  TabList,
  Text,
  Title2,
  makeStyles,
} from "@fluentui/react-components";
import {
  CheckmarkCircle20Regular,
  Circle20Regular,
  Code20Regular,
  Folder20Regular,
  Key20Regular,
  Link20Regular,
  Person20Regular,
  PlugDisconnected20Regular,
} from "@fluentui/react-icons";
import { useState } from "react";
import type { Agent, Connection, ConnectionTestResult, Navigate, Project } from "../types";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { ProviderCard } from "../components/ProviderCard";

const useStyles = makeStyles({
  setup: {
    padding: "18px 20px",
    border: "1px solid #293038",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gridTemplateColumns: "190px minmax(0, 1fr)",
    gap: "24px",
    marginBottom: "22px",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  setupSummary: { display: "grid", alignContent: "start", gap: "5px" },
  setupCount: { fontSize: "28px", lineHeight: "34px", letterSpacing: "-.03em" },
  checklist: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "3px 18px",
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr" },
  },
  checkItem: {
    minHeight: "36px",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    color: "#9ca5af",
  },
  done: { color: "#70b88b" },
  pending: { color: "#65707c" },
  tabs: { marginBottom: "20px", borderBottom: "1px solid #252b31" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "16px",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  panel: {
    padding: "22px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "16px",
  },
  accountHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "14px",
  },
  providerRows: { display: "grid", gap: "2px" },
  providerRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "14px",
    padding: "12px 0",
    borderBottom: "1px solid #252b31",
  },
  configureForm: { display: "grid", gap: "18px" },
  security: {
    padding: "12px",
    borderRadius: "8px",
    backgroundColor: "#15191d",
    color: "#a7b0ba",
    lineHeight: "20px",
  },
  mono: { fontFamily: '"Cascadia Code", Consolas, monospace' },
});

export function ConnectionsPage({
  agents,
  connections,
  navigate,
  projects,
}: {
  agents: Agent[];
  connections: Connection[];
  navigate: Navigate;
  projects: Project[];
}) {
  const styles = useStyles();
  const [tab, setTab] = useState("agents");
  const [configureOpen, setConfigureOpen] = useState(false);
  const [credentialSource, setCredentialSource] = useState("environment");
  const [checking, setChecking] = useState<string>();
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const providers = connections.filter((connection) => connection.category === "AI_PROVIDER");
  const account = connections.find((connection) => connection.category === "MAF_ACCOUNT");
  const hasClaude = agents.some((agent) => agent.id === "claude-code" && agent.available);
  const setupItems = [
    { label: "Không gian dự án", ready: projects.length > 0, optional: false },
    { label: "Claude Code", ready: hasClaude, optional: false },
    { label: "Nhà cung cấp API", ready: false, optional: true },
    { label: "Xác thực production", ready: false, optional: true },
  ];
  const readyCount = setupItems.filter((item) => item.ready).length;
  const test = async (connection: Connection) => {
    setChecking(connection.id);
    try {
      const response = await fetch(`/api/v1/connections/${connection.id}/test`, { method: "POST" });
      const body = (await response.json()) as ConnectionTestResult;
      setResults((previous) => ({ ...previous, [connection.id]: body }));
    } catch (error) {
      setResults((previous) => ({
        ...previous,
        [connection.id]: {
          status: "UNAVAILABLE",
          message: "Không thể hoàn tất kiểm tra.",
          detail: String(error),
        },
      }));
    } finally {
      setChecking(undefined);
    }
  };
  return (
    <>
      <PageHeader
        description="Kết nối agent AI, tài khoản và công cụ MAF có thể sử dụng."
        title="Kết nối"
      />
      <section className={styles.setup} aria-label="Tóm tắt thiết lập">
        <div className={styles.setupSummary}>
          <Text size={200} style={{ color: "#7f8a96" }}>
            THIẾT LẬP
          </Text>
          <Text className={styles.setupCount} weight="semibold">
            {readyCount} / 4
          </Text>
          <Text size={200} style={{ color: "#8d97a2" }}>
            tín hiệu sẵn sàng
          </Text>
        </div>
        <div className={styles.checklist}>
          {setupItems.map((item) => (
            <div className={styles.checkItem} key={item.label}>
              <span className={item.ready ? styles.done : styles.pending}>
                {item.ready ? <CheckmarkCircle20Regular /> : <Circle20Regular />}
              </span>
              <Text size={200}>{item.label}</Text>
              {item.optional ? (
                <Text size={100} style={{ color: "#65707c" }}>
                  Tùy chọn
                </Text>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_event, data) => setTab(String(data.value))}
      >
        <Tab icon={<PlugDisconnected20Regular />} value="agents">
          AI và agent
        </Tab>
        <Tab icon={<Person20Regular />} value="account">
          Tài khoản
        </Tab>
        <Tab icon={<Link20Regular />} value="integrations">
          Tích hợp
        </Tab>
        <Tab icon={<Code20Regular />} value="developer">
          Nhà phát triển
        </Tab>
      </TabList>
      {tab === "agents" ? (
        <div className={styles.grid}>
          {providers.map((connection) => (
            <ProviderCard
              checking={checking === connection.id}
              connection={connection}
              key={connection.id}
              onConfigure={
                connection.id === "openai-api" ? () => setConfigureOpen(true) : undefined
              }
              onTest={connection.id === "claude-code" ? () => void test(connection) : undefined}
              result={results[connection.id]}
            />
          ))}
        </div>
      ) : null}
      {tab === "account" ? (
        <section className={styles.panel}>
          <div className={styles.accountHeader}>
            <div>
              <Title2>Tài khoản MAF</Title2>
              <Text block style={{ color: "#9ca5af", marginTop: 5 }}>
                Đang đăng nhập bằng người dùng local.
              </Text>
            </div>
            <Badge appearance="tint" color="informative">
              Chế độ phát triển
            </Badge>
          </div>
          <div className={styles.providerRows}>
            {["GitHub", "Google", "Email và mật khẩu"].map((provider) => (
              <div className={styles.providerRow} key={provider}>
                <Text>{provider}</Text>
                <Text size={200} style={{ color: "#7f8a96" }}>
                  Khả dụng sau khi cấu hình server
                </Text>
              </div>
            ))}
          </div>
          <Text size={200} style={{ color: "#8d97a2" }}>
            {account?.detail}
          </Text>
        </section>
      ) : null}
      {tab === "integrations" ? (
        <EmptyState
          actionLabel="Xem dự án local"
          description="MAF hiện làm việc với đường dẫn kho mã local. Tích hợp GitHub từ xa chưa được cấu hình."
          icon={<Folder20Regular fontSize={30} />}
          onAction={() => navigate("/projects")}
          title="Chưa có tích hợp bên ngoài"
        />
      ) : null}
      {tab === "developer" ? (
        <section className={styles.panel}>
          <Title2>Chi tiết kết nối</Title2>
          <Text style={{ color: "#9ca5af" }}>
            Các định danh kỹ thuật bên dưới không phải secret.
          </Text>
          <div className={styles.providerRows}>
            {connections.map((connection) => (
              <div className={styles.providerRow} key={connection.id}>
                <div>
                  <Text block>{connection.id}</Text>
                  <Text size={200} style={{ color: "#7f8a96" }}>
                    {connection.method}
                  </Text>
                </div>
                <Text className={styles.mono} size={200}>
                  {connection.credentialReference ?? connection.status}
                </Text>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <Dialog open={configureOpen} onOpenChange={(_event, data) => setConfigureOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Cấu hình OpenAI</DialogTitle>
            <DialogContent className={styles.configureForm}>
              <Text style={{ color: "#9ca5af" }}>
                Executor OpenAI chưa hoạt động trong bản dựng này. Thông tin dưới đây chỉ mô tả
                nguồn credential được hỗ trợ về mặt kiến trúc.
              </Text>
              <Field label="Nguồn credential">
                <RadioGroup
                  value={credentialSource}
                  onChange={(_event, data) => setCredentialSource(data.value)}
                >
                  <Radio label="Biến môi trường" value="environment" />
                  <Radio label="Tham chiếu credential hiện có" value="reference" />
                </RadioGroup>
              </Field>
              {credentialSource === "environment" ? (
                <Field label="Tên biến môi trường">
                  <Input className={styles.mono} readOnly value="OPENAI_API_KEY" />
                </Field>
              ) : (
                <Field label="Tham chiếu MAF">
                  <Input
                    className={styles.mono}
                    readOnly
                    value="credential://user/openai/default"
                  />
                </Field>
              )}
              <div className={styles.security}>
                <Key20Regular style={{ marginRight: 8 }} />
                API key thô không được lưu trong cơ sở dữ liệu dự án MAF. Bản dựng này chưa có kho
                secret bền vững.
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setConfigureOpen(false)}>
                Đóng
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  const connection = providers.find((item) => item.id === "openai-api");
                  if (connection) void test(connection);
                  setConfigureOpen(false);
                }}
              >
                Kiểm tra khả dụng
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
