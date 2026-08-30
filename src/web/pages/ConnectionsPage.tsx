import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  makeStyles,
  Select,
  Tab,
  TabList,
  Text,
  Title2,
} from "@fluentui/react-components";
import {
  Code20Regular,
  Key20Regular,
  Link20Regular,
  Person20Regular,
  PlugDisconnected20Regular,
} from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { ProviderCard } from "../components/ProviderCard";
import type { Agent, Connection, ConnectionTestResult, Navigate, Project } from "../types";

const useStyles = makeStyles({
  tabs: { marginBottom: "20px", borderBottom: "1px solid #252b31" },
  section: { display: "grid", gap: "16px" },
  sectionHeading: { display: "grid", gap: "5px", marginBottom: "2px" },
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
  customPanel: {
    padding: "18px 20px",
    border: "1px dashed #3b4855",
    borderRadius: "12px",
    backgroundColor: "#101519",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "16px",
    "@media (max-width: 600px)": { alignItems: "flex-start", flexDirection: "column" },
  },
  configureForm: { display: "grid", gap: "16px" },
  security: {
    padding: "12px",
    borderRadius: "8px",
    backgroundColor: "#15191d",
    color: "#a7b0ba",
    lineHeight: "20px",
  },
  mono: { fontFamily: '"Cascadia Code", Consolas, monospace' },
  loginState: { display: "grid", gap: "10px", padding: "14px", backgroundColor: "#15191d" },
  providerRows: { display: "grid", gap: "2px" },
  providerRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    gap: "14px",
    padding: "12px 0",
    borderBottom: "1px solid #252b31",
  },
});

interface NativeLoginAttempt {
  id: string;
  providerId: string;
  status: string;
  detail: string;
  expiresAt: string;
}

const terminalLoginStates = new Set([
  "CONNECTED",
  "AUTH_UNVERIFIED",
  "LOGIN_CANCELLED",
  "LOGIN_FAILED",
  "LOGIN_EXPIRED",
]);

export function ConnectionsPage({
  agents: _agents,
  connections,
  navigate,
  refresh,
}: {
  agents: Agent[];
  connections: Connection[];
  navigate: Navigate;
  projects: Project[];
  refresh: () => Promise<void>;
}) {
  const styles = useStyles();
  const [tab, setTab] = useState("agents");
  const [selectedConnection, setSelectedConnection] = useState<Connection>();
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [customName, setCustomName] = useState("");
  const [customProtocol, setCustomProtocol] = useState<
    "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE"
  >("OPENAI_COMPATIBLE");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [customHeaderName, setCustomHeaderName] = useState("");
  const [customHeaderValue, setCustomHeaderValue] = useState("");
  const [customHeaderClassification, setCustomHeaderClassification] = useState<"PUBLIC" | "SECRET">(
    "SECRET",
  );
  const [customTimeoutMs, setCustomTimeoutMs] = useState("10000");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [configurationError, setConfigurationError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const [login, setLogin] = useState<NativeLoginAttempt>();
  const accountAgents = connections.filter((connection) => connection.category === "ACCOUNT_AGENT");
  const providers = connections.filter((connection) => connection.category === "AI_PROVIDER");
  const localVaultAvailable = providers.some((connection) =>
    connection.credentialSources?.some(
      (source) => source.id === "LOCAL_ENCRYPTED_VAULT" && source.available,
    ),
  );
  const selectedIsCustom = selectedConnection?.id === "custom-endpoint";
  const vaultAvailable = selectedConnection?.credentialSources?.some(
    (source) => source.id === "LOCAL_ENCRYPTED_VAULT" && source.available,
  );

  useEffect(() => {
    if (!login || terminalLoginStates.has(login.status)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/v1/connections/${login.providerId}/login/${login.id}`);
          if (!response.ok) return;
          const next = (await response.json()) as NativeLoginAttempt;
          setLogin(next);
          if (next.status === "CONNECTED") await refresh();
        } catch {
          // The next poll can recover a brief local-server restart. No diagnostics are persisted.
        }
      })();
    }, 1_200);
    return () => window.clearInterval(timer);
  }, [login, refresh]);

  const test = async (connection: Connection) => {
    setChecking(connection.id);
    try {
      const response = await fetch(`/api/v1/connections/${connection.id}/test`, { method: "POST" });
      const body = (await response.json()) as ConnectionTestResult;
      setResults((previous) => ({ ...previous, [connection.id]: body }));
      await refresh();
    } catch {
      setResults((previous) => ({
        ...previous,
        [connection.id]: { status: "UNAVAILABLE", message: "Không thể hoàn tất kiểm tra." },
      }));
    } finally {
      setChecking(undefined);
    }
  };

  const configure = (connection: Connection) => {
    setSelectedConnection(connection);
    setApiKey("");
    setDefaultModel(connection.defaultModel ?? "");
    setConfigurationError(undefined);
    setShowAdvanced(false);
  };

  const addCustomConnection = () => {
    setSelectedConnection({
      id: "custom-endpoint",
      category: "AI_PROVIDER",
      provider: "Custom API Endpoint",
      method: "CUSTOM_ENDPOINT",
      status: "NOT_CONFIGURED",
      capability: "OpenAI hoặc Anthropic compatible endpoint",
      detail: "API key và header bí mật được lưu trong vault cục bộ.",
      credentialSources: [
        {
          id: "LOCAL_ENCRYPTED_VAULT",
          label: "Vault mã hóa cục bộ",
          available: localVaultAvailable,
          detail: "Tự tạo an toàn cho phiên server hiện tại.",
        },
      ],
    });
    setApiKey("");
    setDefaultModel("");
    setCustomName("");
    setCustomProtocol("OPENAI_COMPATIBLE");
    setCustomBaseUrl("");
    setCustomHeaderName("");
    setCustomHeaderValue("");
    setCustomHeaderClassification("SECRET");
    setCustomTimeoutMs("10000");
    setShowAdvanced(false);
    setConfigurationError(undefined);
  };

  const closeConfiguration = () => {
    setSelectedConnection(undefined);
    setApiKey("");
    setConfigurationError(undefined);
  };

  const saveConfiguration = async () => {
    if (!selectedConnection) return;
    setSaving(true);
    setConfigurationError(undefined);
    try {
      const payload = selectedIsCustom
        ? {
            name: customName,
            protocol: customProtocol,
            baseUrl: customBaseUrl,
            apiKey,
            model: defaultModel,
            headers: customHeaderName
              ? [
                  {
                    name: customHeaderName,
                    value: customHeaderValue,
                    classification: customHeaderClassification,
                  },
                ]
              : [],
            timeoutMs: Number(customTimeoutMs),
          }
        : { source: "LOCAL_ENCRYPTED_VAULT", apiKey, model: defaultModel || undefined };
      const response = await fetch(
        selectedIsCustom
          ? "/api/v1/connections/custom"
          : `/api/v1/connections/${selectedConnection.id}/configure`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? "Không thể lưu cấu hình provider.");
      await refresh();
      closeConfiguration();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : "Không thể lưu cấu hình.");
    } finally {
      setSaving(false);
    }
  };

  const startLogin = async (connection: Connection) => {
    if (connection.status === "CLI_UNAVAILABLE") {
      window.open(connection.authCapabilities?.installUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (connection.status === "OAUTH_CONFIGURATION_REQUIRED") {
      setResults((previous) => ({
        ...previous,
        [connection.id]: {
          status: "OAUTH_CONFIGURATION_REQUIRED",
          detail: connection.detail,
        },
      }));
      return;
    }
    try {
      if (connection.method === "OAUTH_PKCE") {
        const response = await fetch(`/api/v1/connections/${connection.id}/oauth/authorize`, {
          method: "POST",
        });
        const body = (await response.json()) as { url?: string; message?: string };
        if (!response.ok || !body.url) throw new Error(body.message ?? "OAuth chưa sẵn sàng.");
        window.location.assign(body.url);
        return;
      }
      const response = await fetch(`/api/v1/connections/${connection.id}/login`, {
        method: "POST",
      });
      const body = (await response.json()) as NativeLoginAttempt & { message?: string };
      if (!response.ok || !body.id)
        throw new Error(body.message ?? "Không thể khởi tạo đăng nhập.");
      setLogin(body);
    } catch (error) {
      setResults((previous) => ({
        ...previous,
        [connection.id]: {
          status:
            connection.method === "OAUTH_PKCE" ? "OAUTH_CONFIGURATION_REQUIRED" : "LOGIN_FAILED",
          detail: error instanceof Error ? error.message : "Không thể khởi tạo đăng nhập.",
        },
      }));
    }
  };

  const cancelLogin = async () => {
    if (!login) return;
    try {
      const response = await fetch(`/api/v1/connections/${login.providerId}/login/${login.id}`, {
        method: "DELETE",
      });
      if (response.ok) setLogin((await response.json()) as NativeLoginAttempt);
    } catch {
      // The bounded server-side timeout also cleans up the process if the request is interrupted.
    }
  };

  const disconnect = async (connection: Connection) => {
    try {
      const response = await fetch(`/api/v1/connections/${connection.id}/disconnect`, {
        method: "POST",
      });
      if (!response.ok) {
        const body = (await response.json()) as { message?: string };
        throw new Error(body.message ?? "Không thể ngắt kết nối.");
      }
      await refresh();
      setResults((previous) => {
        const next = { ...previous };
        delete next[connection.id];
        return next;
      });
    } catch (error) {
      setResults((previous) => ({
        ...previous,
        [connection.id]: {
          status: "ERROR",
          detail: error instanceof Error ? error.message : "Không thể ngắt kết nối.",
        },
      }));
    }
  };

  return (
    <>
      <PageHeader
        actions={
          tab === "api" ? (
            <Button appearance="primary" icon={<Key20Regular />} onClick={addCustomConnection}>
              Thêm endpoint tùy chỉnh
            </Button>
          ) : undefined
        }
        description="Đăng nhập agent bằng phiên tài khoản provider hoặc cấu hình API key riêng. Phiên account và quota API được tách biệt."
        title="Kết nối"
      />
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_event, data) => setTab(String(data.value))}
      >
        <Tab icon={<Person20Regular />} value="agents">
          AI và agent
        </Tab>
        <Tab icon={<Key20Regular />} value="api">
          API Providers
        </Tab>
        <Tab icon={<Link20Regular />} value="integrations">
          Tích hợp
        </Tab>
        <Tab icon={<Code20Regular />} value="developer">
          Nhà phát triển
        </Tab>
      </TabList>
      {tab === "agents" ? (
        <section className={styles.section} aria-label="Tài khoản và agent">
          <div className={styles.sectionHeading}>
            <Title2>Accounts & Agents</Title2>
            <Text style={{ color: "#9ca5af" }}>
              MAF dùng luồng chính thức của provider. Phiên account và quota vẫn do provider quản
              lý; chỉ provider có executor hỗ trợ mới dùng được quota account trong MAF.
            </Text>
          </div>
          <div className={styles.grid}>
            {accountAgents.map((connection) => (
              <ProviderCard
                checking={checking === connection.id}
                connection={connection}
                configureActionLabel={
                  connection.credentialReference ? "Quản lý API key" : "Thêm API key"
                }
                key={connection.id}
                onDisconnect={
                  connection.status === "CONNECTED" || connection.status === "CLI_READY"
                    ? () => void disconnect(connection)
                    : undefined
                }
                onPrimaryAction={
                  connection.authCapabilities?.supportsNativeLogin === false
                    ? undefined
                    : () => void startLogin(connection)
                }
                onTest={() => void test(connection)}
                primaryActionDisabled={connection.status === "OAUTH_CONFIGURATION_REQUIRED"}
                primaryActionLabel={
                  connection.status === "CLI_UNAVAILABLE"
                    ? connection.id === "codex-cli"
                      ? "Cài Codex CLI"
                      : connection.id === "antigravity-cli"
                        ? "Hướng dẫn Antigravity"
                        : "Cài Claude Code"
                    : connection.status === "OAUTH_CONFIGURATION_REQUIRED"
                      ? "Cần cấu hình server"
                      : connection.id === "antigravity-cli"
                        ? "Đăng nhập trong Antigravity IDE"
                        : connection.status === "CONNECTED"
                          ? "Kết nối lại"
                          : "Đăng nhập"
                }
                result={results[connection.id]}
              />
            ))}
          </div>
        </section>
      ) : null}
      {tab === "api" ? (
        <section className={styles.section} aria-label="API providers">
          <div className={styles.sectionHeading}>
            <Title2>API Providers</Title2>
            <Text style={{ color: "#9ca5af" }}>
              Mỗi preset đã có protocol và endpoint chuẩn. Nhập API key của riêng bạn, tùy chọn
              model mặc định.
            </Text>
          </div>
          <div className={styles.grid}>
            {providers.map((connection) => (
              <ProviderCard
                checking={checking === connection.id}
                connection={connection}
                key={connection.id}
                onConfigure={() => configure(connection)}
                onDisconnect={
                  connection.credentialReference ? () => void disconnect(connection) : undefined
                }
                onTest={() => void test(connection)}
                result={results[connection.id]}
              />
            ))}
          </div>
          <div className={styles.customPanel}>
            <div>
              <Text block weight="semibold">
                Custom API Endpoint
              </Text>
              <Text size={200} style={{ color: "#9ca5af" }}>
                Dành cho OpenAI-compatible, Anthropic-compatible, gateway doanh nghiệp và proxy
                local.
              </Text>
            </div>
            <Button appearance="secondary" onClick={addCustomConnection}>
              Thêm endpoint
            </Button>
          </div>
        </section>
      ) : null}
      {tab === "integrations" ? (
        <EmptyState
          actionLabel="Xem dự án local"
          description="MAF hiện làm việc với kho mã local. Tích hợp GitHub từ xa chưa được cấu hình."
          icon={<PlugDisconnected20Regular fontSize={30} />}
          onAction={() => navigate("/projects")}
          title="Chưa có tích hợp bên ngoài"
        />
      ) : null}
      {tab === "developer" ? (
        <section className={styles.panel}>
          <Title2>Chi tiết kết nối</Title2>
          <Text style={{ color: "#9ca5af" }}>
            Chỉ hiển thị định danh không bí mật. API key, access token và native-session token không
            bao giờ được trả về giao diện.
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
                  {connection.connectionReference ??
                    connection.credentialReference ??
                    connection.status}
                </Text>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <Dialog
        open={Boolean(login)}
        onOpenChange={(_event, data) => !data.open && void cancelLogin()}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              Đăng nhập {accountAgents.find((item) => item.id === login?.providerId)?.provider}
            </DialogTitle>
            <DialogContent className={styles.configureForm}>
              <Text>
                MAF đã khởi tạo luồng xác thực native. Hoàn tất trong trình duyệt provider khi trình
                duyệt mở.
              </Text>
              <div className={styles.loginState}>
                <Text weight="semibold">{login?.status}</Text>
                <Text size={200}>{login?.detail}</Text>
                <Text size={100} style={{ color: "#8d97a2" }}>
                  Phiên hết hạn lúc{" "}
                  {login?.expiresAt ? new Date(login.expiresAt).toLocaleTimeString() : ""}.
                </Text>
              </div>
              {login && terminalLoginStates.has(login.status) && login.status !== "CONNECTED" ? (
                <Text style={{ color: "#f19c99" }}>
                  Bạn có thể đóng hộp thoại và thử lại từ card kết nối.
                </Text>
              ) : null}
            </DialogContent>
            <DialogActions>
              {login && !terminalLoginStates.has(login.status) ? (
                <Button appearance="secondary" onClick={() => void cancelLogin()}>
                  Hủy
                </Button>
              ) : null}
              <Button appearance="primary" onClick={() => setLogin(undefined)}>
                Đóng
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={Boolean(selectedConnection)}
        onOpenChange={(_event, data) => !data.open && closeConfiguration()}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              {selectedIsCustom
                ? "Thêm custom endpoint"
                : `API key - ${selectedConnection?.provider}`}
            </DialogTitle>
            <DialogContent className={styles.configureForm}>
              <Text style={{ color: "#9ca5af" }}>
                {selectedIsCustom
                  ? "Thiết lập endpoint tương thích. API key và header bí mật sẽ không được hiển thị lại sau khi lưu."
                  : "Nhập API key riêng. Gói ChatGPT, Claude hoặc Grok consumer không được xem là API credential."}
              </Text>
              {selectedIsCustom ? (
                <>
                  <Field label="Tên kết nối">
                    <Input
                      value={customName}
                      onChange={(_event, data) => setCustomName(data.value)}
                    />
                  </Field>
                  <Field label="Protocol">
                    <Select
                      value={customProtocol}
                      onChange={(_event, data) =>
                        setCustomProtocol(
                          data.value as "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE",
                        )
                      }
                    >
                      <option value="OPENAI_COMPATIBLE">OpenAI Compatible</option>
                      <option value="ANTHROPIC_COMPATIBLE">Anthropic Compatible</option>
                    </Select>
                  </Field>
                  <Field label="Base URL">
                    <Input
                      className={styles.mono}
                      placeholder="https://api.example.com/v1"
                      value={customBaseUrl}
                      onChange={(_event, data) => setCustomBaseUrl(data.value)}
                    />
                  </Field>
                </>
              ) : null}
              <Field label="API key">
                <Input
                  className={styles.mono}
                  type="password"
                  value={apiKey}
                  onChange={(_event, data) => setApiKey(data.value)}
                />
              </Field>
              <Field label="Model mặc định (tùy chọn)">
                <Input
                  className={styles.mono}
                  placeholder={selectedIsCustom ? "glm-5.3" : "Để provider tự chọn"}
                  value={defaultModel}
                  onChange={(_event, data) => setDefaultModel(data.value)}
                />
              </Field>
              {selectedIsCustom ? (
                <>
                  <Button appearance="subtle" onClick={() => setShowAdvanced((value) => !value)}>
                    {showAdvanced ? "Ẩn cài đặt nâng cao" : "Cài đặt nâng cao"}
                  </Button>
                  {showAdvanced ? (
                    <div className={styles.configureForm}>
                      <Field label="Timeout (ms)">
                        <Input
                          type="number"
                          value={customTimeoutMs}
                          onChange={(_event, data) => setCustomTimeoutMs(data.value)}
                        />
                      </Field>
                      <Field label="Tên custom header">
                        <Input
                          value={customHeaderName}
                          onChange={(_event, data) => setCustomHeaderName(data.value)}
                        />
                      </Field>
                      <Field label="Giá trị custom header">
                        <Input
                          type={customHeaderClassification === "SECRET" ? "password" : "text"}
                          value={customHeaderValue}
                          onChange={(_event, data) => setCustomHeaderValue(data.value)}
                        />
                      </Field>
                      <Field label="Phân loại header">
                        <Select
                          value={customHeaderClassification}
                          onChange={(_event, data) =>
                            setCustomHeaderClassification(data.value as "PUBLIC" | "SECRET")
                          }
                        >
                          <option value="SECRET">Secret - lưu trong vault</option>
                          <option value="PUBLIC">Public - metadata kết nối</option>
                        </Select>
                      </Field>
                    </div>
                  ) : null}
                </>
              ) : null}
              <div className={styles.security}>
                API key và header bí mật được mã hóa AES-256-GCM trong vault local tự tạo. MAF không
                lưu key trong database hay trả key về trình duyệt; khi server khởi động lại, bạn cần
                cấu hình lại endpoint.
              </div>
              {configurationError ? (
                <Text style={{ color: "#f19c99" }}>{configurationError}</Text>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={closeConfiguration}>
                Hủy
              </Button>
              <Button
                appearance="primary"
                disabled={
                  saving ||
                  !vaultAvailable ||
                  !apiKey ||
                  (selectedIsCustom &&
                    (!customName ||
                      !customBaseUrl ||
                      !defaultModel ||
                      Boolean(customHeaderName) !== Boolean(customHeaderValue)))
                }
                onClick={() => void saveConfiguration()}
              >
                {saving ? "Đang lưu" : "Lưu API key"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
