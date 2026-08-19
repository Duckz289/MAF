import { Button, Tab, TabList, Text, Title2, makeStyles } from "@fluentui/react-components";
import { ArrowLeft20Regular, Code20Regular, Folder20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import type { Navigate, Project, Run } from "../types";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskList } from "../components/TaskRow";

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
});

export function ProjectPage({
  navigate,
  project,
  runs,
}: {
  navigate: Navigate;
  project?: Project | undefined;
  runs: Run[];
}) {
  const styles = useStyles();
  const [tab, setTab] = useState("overview");
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
        <Tab value="tasks">Tác vụ</Tab>
        <Tab value="files">Tệp và ngữ cảnh</Tab>
        <Tab value="settings">Cài đặt</Tab>
      </TabList>
      {tab === "overview" ? (
        <div className={styles.overview}>
          <section style={{ display: "grid", gap: 12 }}>
            <Title2>Tác vụ gần đây</Title2>
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
          </section>
          <aside className={styles.panel}>
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
                  Agent mặc định
                </Text>
                <Text>Tự động theo server</Text>
              </div>
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
      {tab === "files" ? (
        <div className={styles.panel}>
          <Folder20Regular fontSize={28} />
          <Title2>Ngữ cảnh từ kho mã local</Title2>
          <Text style={{ color: "#9ca5af" }}>
            MAF lập chỉ mục kho mã khi tác vụ bắt đầu. Project Graph và snapshot kỹ thuật chỉ hiển
            thị trong phần Nâng cao của tác vụ.
          </Text>
          <Text className={styles.mono}>{project.repositoryPath}</Text>
        </div>
      ) : null}
      {tab === "settings" ? (
        <div className={styles.panel}>
          <Code20Regular fontSize={28} />
          <Title2>Cài đặt dự án</Title2>
          <Text style={{ color: "#9ca5af" }}>
            Bản dựng hiện tại chưa hỗ trợ cập nhật dự án sau khi thêm. Các giá trị bên dưới là chỉ
            đọc.
          </Text>
          <div className={styles.facts}>
            <div className={styles.fact}>
              <Text size={200}>Ưu tiên chất lượng</Text>
              <Text>{project.preferences.qualityPreference ?? "Cân bằng"}</Text>
            </div>
            <div className={styles.fact}>
              <Text size={200}>Ưu tiên ngân sách</Text>
              <Text>{project.preferences.budgetPreference ?? "Tự động"}</Text>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
