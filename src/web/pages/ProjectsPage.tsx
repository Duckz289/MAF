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
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
} from "@fluentui/react-components";
import {
  Add20Regular,
  ArrowRight20Regular,
  BranchFork20Regular,
  Folder20Regular,
} from "@fluentui/react-icons";
import { useState, type FormEvent } from "react";
import type { Navigate, Project, Run } from "../types";
import { formatCost, formatRelativeTime } from "../utils";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(310px, 1fr))",
    gap: "14px",
  },
  card: {
    minHeight: "218px",
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "flex",
    flexDirection: "column",
    gap: "17px",
    transitionProperty: "border-color, background-color, transform",
    transitionDuration: "160ms",
  },
  cardTop: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "14px",
  },
  projectName: { display: "flex", alignItems: "center", gap: "10px" },
  icon: {
    width: "34px",
    height: "34px",
    borderRadius: "8px",
    backgroundColor: "#1b2632",
    color: "#75a9f2",
    display: "grid",
    placeItems: "center",
  },
  repo: {
    color: "#aab2bc",
    fontFamily: '"Cascadia Code", Consolas, monospace',
    overflowWrap: "anywhere",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "8px 16px",
    flexWrap: "wrap",
    color: "#7f8a96",
  },
  recent: { display: "grid", gap: "4px", paddingTop: "13px", borderTop: "1px solid #252b31" },
  cardAction: { marginTop: "auto", alignSelf: "flex-start" },
  form: { display: "grid", gap: "18px" },
});

export function ProjectsPage({
  navigate,
  projects,
  refresh,
  runs,
}: {
  navigate: Navigate;
  projects: Project[];
  refresh: () => Promise<void>;
  runs: Run[];
}) {
  const styles = useStyles();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [revision, setRevision] = useState("HEAD");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, repositoryPath, revision }),
      });
      if (!response.ok) throw new Error(`Tạo dự án trả về ${response.status}`);
      const project = (await response.json()) as Project;
      setName("");
      setRepositoryPath("");
      setRevision("HEAD");
      setOpen(false);
      await refresh();
      navigate(`/projects/${project.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <PageHeader
        actions={
          projects.length ? (
            <Button appearance="primary" icon={<Add20Regular />} onClick={() => setOpen(true)}>
              Thêm dự án
            </Button>
          ) : undefined
        }
        description="Các kho mã local MAF có thể dùng làm ngữ cảnh cho tác vụ."
        title="Dự án"
      />
      {projects.length ? (
        <div className={styles.grid}>
          {projects.map((project) => {
            const projectRuns = runs.filter((run) => run.repositoryPath === project.repositoryPath);
            const recent = projectRuns[0];
            const recorded = projectRuns.reduce((sum, run) => sum + run.cost.total, 0);
            return (
              <article className={styles.card} key={project.id}>
                <div className={styles.cardTop}>
                  <div className={styles.projectName}>
                    <span className={styles.icon} aria-hidden="true">
                      <Folder20Regular />
                    </span>
                    <Text size={400} weight="semibold">
                      {project.name}
                    </Text>
                  </div>
                  <Text size={200} style={{ color: "#70b88b" }}>
                    Sẵn sàng
                  </Text>
                </div>
                <Text className={styles.repo} size={200}>
                  {project.repositoryPath}
                </Text>
                <div className={styles.meta}>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <BranchFork20Regular />
                    <Text size={200}>{project.revision}</Text>
                  </span>
                  <Text size={200}>Agent mặc định: Tự động</Text>
                  <Text size={200}>
                    {recorded > 0 ? formatCost(recorded) : "Chi phí chưa khả dụng"}
                  </Text>
                </div>
                <div className={styles.recent}>
                  <Text size={100} style={{ color: "#727d88" }}>
                    TÁC VỤ GẦN NHẤT
                  </Text>
                  <Text size={200}>{recent?.task ?? "Chưa có tác vụ"}</Text>
                  {recent ? (
                    <Text size={100} style={{ color: "#727d88" }}>
                      {formatRelativeTime(recent.updatedAt)}
                    </Text>
                  ) : null}
                </div>
                <Button
                  appearance="subtle"
                  className={styles.cardAction}
                  icon={<ArrowRight20Regular />}
                  iconPosition="after"
                  onClick={() => navigate(`/projects/${project.id}`)}
                >
                  Mở dự án
                </Button>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          actionLabel="Thêm dự án"
          description="Thêm đường dẫn kho mã local để MAF có ngữ cảnh bắt đầu làm việc."
          icon={<Folder20Regular fontSize={30} />}
          onAction={() => setOpen(true)}
          title="Chưa có dự án"
        />
      )}
      <Dialog open={open} onOpenChange={(_event, data) => setOpen(data.open)}>
        <DialogSurface>
          <form onSubmit={(event) => void submit(event)}>
            <DialogBody>
              <DialogTitle>Thêm dự án local</DialogTitle>
              <DialogContent className={styles.form}>
                <Text style={{ color: "#9ca5af" }}>
                  Dữ liệu dự án hiện chỉ tồn tại trong tiến trình local của MAF.
                </Text>
                <Field label="Tên dự án" required>
                  <Input value={name} onChange={(_event, data) => setName(data.value)} />
                </Field>
                <Field
                  label="Đường dẫn kho mã"
                  required
                  hint="MAF tạo worktree riêng cho từng tác vụ."
                >
                  <Input
                    value={repositoryPath}
                    onChange={(_event, data) => setRepositoryPath(data.value)}
                  />
                </Field>
                <Field label="Nhánh hoặc revision">
                  <Input value={revision} onChange={(_event, data) => setRevision(data.value)} />
                </Field>
                {error ? (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      Không thể thêm dự án.
                      <details>
                        <summary>Chi tiết kỹ thuật</summary>
                        {error}
                      </details>
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setOpen(false)} type="button">
                  Hủy
                </Button>
                <Button
                  appearance="primary"
                  disabled={saving || !name.trim() || !repositoryPath.trim()}
                  type="submit"
                >
                  {saving ? "Đang thêm" : "Thêm dự án"}
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>
    </>
  );
}
