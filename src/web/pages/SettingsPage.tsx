import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  Tab,
  TabList,
  Text,
  Title2,
} from "@fluentui/react-components";
import { Code20Regular, Key20Regular, Settings20Regular } from "@fluentui/react-icons";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../components/PageHeader";
import type { Agent, PlatformKey } from "../types";
import { formatDate, readJson } from "../utils";

const useStyles = makeStyles({
  tabs: { marginBottom: "20px", borderBottom: "1px solid #252b31" },
  panel: {
    maxWidth: "880px",
    padding: "22px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "18px",
  },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "14px",
  },
  rows: { display: "grid" },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(200px, .65fr) minmax(0, 1.35fr)",
    gap: "18px",
    padding: "14px 0",
    borderBottom: "1px solid #252b31",
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr", gap: "4px" },
  },
  keyRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: "16px",
    padding: "12px 0",
    borderBottom: "1px solid #252b31",
  },
  quiet: { color: "#7f8a96" },
  oneTimeKey: {
    display: "block",
    margin: "10px 0",
    overflowWrap: "anywhere",
    fontFamily: '"Cascadia Code", Consolas, monospace',
  },
});

export function SettingsPage({ agents }: { agents: Agent[] }) {
  const styles = useStyles();
  const [tab, setTab] = useState("general");
  const [keys, setKeys] = useState<PlatformKey[]>([]);
  const [oneTimeKey, setOneTimeKey] = useState<string>();
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      setKeys(await readJson<PlatformKey[]>("/api/v1/platform-keys?ownerId=development-user"));
    } catch {
      setKeys([]);
    }
  }, []);
  useEffect(() => void load(), [load]);
  const create = async () => {
    setCreating(true);
    try {
      const response = await fetch("/api/v1/platform-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerId: "development-user", scopes: ["runs.create"] }),
      });
      const body = (await response.json()) as { key: string };
      setOneTimeKey(body.key);
      await load();
    } finally {
      setCreating(false);
    }
  };
  const revoke = async (id: string) => {
    await fetch(`/api/v1/platform-keys/${id}/revoke`, { method: "POST" });
    await load();
  };
  const activeAgent = agents.find((agent) => agent.active);
  return (
    <>
      <PageHeader
        description="Chỉ các cài đặt và trạng thái mà server hiện hỗ trợ được hiển thị tại đây."
        title="Cài đặt"
      />
      <TabList
        className={styles.tabs}
        selectedValue={tab}
        onTabSelect={(_event, data) => setTab(String(data.value))}
      >
        <Tab icon={<Settings20Regular />} value="general">
          Chung
        </Tab>
        <Tab icon={<Code20Regular />} value="developer">
          Nhà phát triển
        </Tab>
      </TabList>
      {tab === "general" ? (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <Title2>Môi trường local</Title2>
            <Badge appearance="tint" color="informative">
              Phát triển
            </Badge>
          </div>
          <div className={styles.rows}>
            <div className={styles.row}>
              <Text className={styles.quiet}>Agent đang hoạt động</Text>
              <Text>{activeAgent?.name ?? "Do server chọn"}</Text>
            </div>
            <div className={styles.row}>
              <Text className={styles.quiet}>Xác thực tài khoản</Text>
              <Text>Người dùng phát triển local</Text>
            </div>
            <div className={styles.row}>
              <Text className={styles.quiet}>Độ bền dữ liệu dự án</Text>
              <Text>Chỉ trong tiến trình. Khởi động lại server sẽ xóa danh mục dự án.</Text>
            </div>
            <div className={styles.row}>
              <Text className={styles.quiet}>Mặc định thực thi</Text>
              <Text>Do server và tín hiệu runtime có bằng chứng quyết định.</Text>
            </div>
          </div>
          <Text className={styles.quiet} size={200}>
            Mặc định chất lượng, ngân sách và giao diện chưa có API lưu cấu hình nên không được hiển
            thị như control có thể chỉnh sửa.
          </Text>
        </section>
      ) : null}
      {tab === "developer" ? (
        <section className={styles.panel}>
          <div className={styles.sectionHead}>
            <div>
              <Title2>API key nền tảng</Title2>
              <Text block className={styles.quiet} size={200}>
                Dùng để gọi MAF, không phải credential của model provider.
              </Text>
            </div>
            <Button
              appearance="primary"
              disabled={creating}
              icon={<Key20Regular />}
              onClick={() => void create()}
            >
              {creating ? "Đang tạo" : "Tạo API key"}
            </Button>
          </div>
          <MessageBar intent="warning">
            <MessageBarBody>
              Key chỉ tồn tại trong bộ nhớ của server phát triển và sẽ mất khi server khởi động lại.
            </MessageBarBody>
          </MessageBar>
          {oneTimeKey ? (
            <MessageBar intent="success">
              <MessageBarBody>
                Sao chép key ngay. Giá trị này sẽ không hiển thị lại.
                <code className={styles.oneTimeKey}>{oneTimeKey}</code>
                <Button appearance="subtle" onClick={() => setOneTimeKey(undefined)}>
                  Tôi đã sao chép
                </Button>
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <div>
            {keys.length ? (
              keys.map((key) => (
                <div className={styles.keyRow} key={key.id}>
                  <div>
                    <Text block weight="semibold">
                      {key.id.slice(0, 8)}
                    </Text>
                    <Text className={styles.quiet} size={100}>
                      {key.scopes.join(", ")} | {formatDate(key.createdAt)}
                    </Text>
                  </div>
                  {key.revoked ? (
                    <Badge appearance="tint">Đã thu hồi</Badge>
                  ) : (
                    <Button appearance="secondary" onClick={() => void revoke(key.id)}>
                      Thu hồi
                    </Button>
                  )}
                </div>
              ))
            ) : (
              <Text className={styles.quiet}>Chưa tạo API key nào.</Text>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}
