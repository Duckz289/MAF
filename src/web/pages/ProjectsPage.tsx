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
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
} from "@fluentui/react-components";
import {
  Add20Regular,
  ArrowRight20Regular,
  BranchFork20Regular,
  CheckmarkCircle20Regular,
  Folder20Regular,
  FolderOpen20Regular,
  Warning20Regular,
} from "@fluentui/react-icons";
import { type FormEvent, useState } from "react";
import { EmptyState } from "../components/EmptyState";
import { FolderBrowserDialog } from "../components/FolderBrowserDialog";
import { PageHeader } from "../components/PageHeader";
import type { Navigate, Project, ProjectDetection, Run } from "../types";
import { formatCost, formatRelativeTime } from "../utils";

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
  form: { display: "grid", gap: "16px" },
  picker: {
    padding: "26px",
    border: "1px dashed #343b43",
    borderRadius: "10px",
    display: "grid",
    justifyItems: "center",
    gap: "12px",
    textAlign: "center",
  },
  manualToggle: { justifySelf: "start" },
  detected: {
    padding: "16px",
    border: "1px solid #252b31",
    borderRadius: "10px",
    backgroundColor: "#0f1113",
    display: "grid",
    gap: "12px",
  },
  detectedHead: { display: "flex", alignItems: "center", gap: "9px" },
  factGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(110px, .4fr) minmax(0, 1fr)",
    gap: "8px 14px",
  },
  chipRow: { display: "flex", gap: "6px", flexWrap: "wrap" },
  mono: { fontFamily: '"Cascadia Code", Consolas, monospace', overflowWrap: "anywhere" },
  unknowns: { display: "grid", gap: "4px" },
  changeFolder: { justifySelf: "start" },
});

const basename = (input: string): string => {
  const normalized = input.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.split("/").pop() || normalized;
};

function DetectedSummary({ detection }: { detection: ProjectDetection }) {
  const styles = useStyles();
  return (
    <div className={styles.detected}>
      <div className={styles.detectedHead}>
        {detection.git.present ? (
          <CheckmarkCircle20Regular primaryFill="#70b88b" />
        ) : (
          <Warning20Regular primaryFill="#d9a441" />
        )}
        <Text weight="semibold">
          {detection.git.present ? "MAF đã phát hiện thông tin dự án" : "Không phải kho Git"}
        </Text>
      </div>
      <div className={styles.factGrid}>
        {detection.git.present ? (
          <>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Git
            </Text>
            <Text size={200}>
              {detection.git.branch ?? "?"} · {detection.git.revision ?? "?"}
              {detection.git.dirty ? " · có thay đổi chưa commit" : ""}
            </Text>
          </>
        ) : null}
        {detection.languages.length ? (
          <>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Ngôn ngữ
            </Text>
            <div className={styles.chipRow}>
              {detection.languages.map((language) => (
                <Badge appearance="tint" key={language}>
                  {language}
                </Badge>
              ))}
            </div>
          </>
        ) : null}
        {detection.frameworks.length ? (
          <>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Framework
            </Text>
            <div className={styles.chipRow}>
              {detection.frameworks.map((framework) => (
                <Badge appearance="tint" color="informative" key={framework}>
                  {framework}
                </Badge>
              ))}
            </div>
          </>
        ) : null}
        {detection.packageManager ? (
          <>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Package manager
            </Text>
            <Text size={200}>{detection.packageManager}</Text>
          </>
        ) : null}
        <Text size={200} style={{ color: "#7f8a96" }}>
          Cấu trúc
        </Text>
        <Text size={200}>
          {detection.monorepo
            ? `${detection.moduleRoots.length} package/module`
            : "Một package duy nhất"}
          {detection.trackedFileCount !== undefined
            ? ` · ${detection.trackedFileCount}${detection.trackedFileCountTruncated ? "+" : ""} tệp theo dõi bởi Git`
            : ""}
        </Text>
        {detection.verificationCommands.length ? (
          <>
            <Text size={200} style={{ color: "#7f8a96" }}>
              Xác minh
            </Text>
            <div>
              {detection.verificationCommands.map((entry) => (
                <Text block className={styles.mono} key={entry.command} size={200}>
                  {entry.label}: {entry.command}
                </Text>
              ))}
            </div>
          </>
        ) : null}
      </div>
      {detection.unknowns.length ? (
        <div className={styles.unknowns}>
          <Text size={100} style={{ color: "#727d88" }}>
            CHƯA XÁC ĐỊNH
          </Text>
          {detection.unknowns.map((unknown) => (
            <Text className={styles.mono} key={unknown} size={100} style={{ color: "#8d97a2" }}>
              {unknown}
            </Text>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  const [browsing, setBrowsing] = useState(false);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [revision, setRevision] = useState("");
  const [detection, setDetection] = useState<ProjectDetection>();
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const resetForm = () => {
    setName("");
    setNameEdited(false);
    setRepositoryPath("");
    setRevision("");
    setDetection(undefined);
    setError(undefined);
    setManual(false);
  };

  const chooseFolder = async (chosenPath: string) => {
    setBrowsing(false);
    setRepositoryPath(chosenPath);
    if (!nameEdited) setName(basename(chosenPath));
    setDetecting(true);
    setDetection(undefined);
    try {
      setDetection(
        await (
          await fetch("/api/v1/filesystem/detect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repositoryPath: chosenPath }),
          })
        ).json(),
      );
    } catch {
      setDetection(undefined);
    } finally {
      setDetecting(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch("/api/v1/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          repositoryPath,
          ...(revision.trim() ? { revision: revision.trim() } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Tạo dự án trả về ${response.status}`);
      const project = (await response.json()) as Project;
      resetForm();
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
          description="Chọn một thư mục kho mã local để MAF có ngữ cảnh bắt đầu làm việc."
          icon={<Folder20Regular fontSize={30} />}
          onAction={() => setOpen(true)}
          title="Chưa có dự án"
        />
      )}
      <Dialog
        open={open}
        onOpenChange={(_event, data) => {
          setOpen(data.open);
          if (!data.open) resetForm();
        }}
      >
        <DialogSurface>
          <form onSubmit={(event) => void submit(event)}>
            <DialogBody>
              <DialogTitle>Thêm dự án local</DialogTitle>
              <DialogContent className={styles.form}>
                <Text style={{ color: "#9ca5af" }}>
                  Dữ liệu dự án hiện chỉ tồn tại trong tiến trình local của MAF.
                </Text>
                {!repositoryPath ? (
                  <>
                    <div className={styles.picker}>
                      <FolderOpen20Regular fontSize={26} />
                      <Text weight="semibold">Chọn thư mục kho mã trên máy này</Text>
                      <Text size={200} style={{ color: "#8d97a2" }}>
                        MAF sẽ tự phát hiện ngôn ngữ, framework và lệnh xác minh.
                      </Text>
                      <Button appearance="primary" onClick={() => setBrowsing(true)} type="button">
                        Chọn thư mục
                      </Button>
                    </div>
                    <Button
                      appearance="subtle"
                      className={styles.manualToggle}
                      onClick={() => setManual((value) => !value)}
                      type="button"
                    >
                      {manual ? "Ẩn nhập đường dẫn thủ công" : "Nhập đường dẫn thủ công"}
                    </Button>
                    {manual ? (
                      <Field
                        hint="Dùng khi bạn không muốn duyệt bằng trình chọn thư mục."
                        label="Đường dẫn kho mã"
                      >
                        <Input
                          onChange={(_event, data) => setRepositoryPath(data.value)}
                          placeholder="C:\dev\my-project"
                          value={repositoryPath}
                        />
                        <Button
                          appearance="secondary"
                          disabled={!repositoryPath.trim()}
                          onClick={() => void chooseFolder(repositoryPath.trim())}
                          style={{ marginTop: 8 }}
                          type="button"
                        >
                          Dùng đường dẫn này
                        </Button>
                      </Field>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Field label="Thư mục đã chọn">
                      <Text block className={styles.mono}>
                        {repositoryPath}
                      </Text>
                    </Field>
                    <Button
                      appearance="subtle"
                      className={styles.changeFolder}
                      onClick={() => {
                        setRepositoryPath("");
                        setDetection(undefined);
                      }}
                      type="button"
                    >
                      Đổi thư mục khác
                    </Button>
                    {detecting ? (
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <Spinner size="tiny" />
                        <Text size={200}>Đang phát hiện thông tin dự án…</Text>
                      </div>
                    ) : detection ? (
                      <DetectedSummary detection={detection} />
                    ) : null}
                    <Field label="Tên dự án" required>
                      <Input
                        onChange={(_event, data) => {
                          setNameEdited(true);
                          setName(data.value);
                        }}
                        value={name}
                      />
                    </Field>
                    <details>
                      <summary>
                        <Text weight="semibold">Nâng cao</Text>
                      </summary>
                      <div style={{ marginTop: 10 }}>
                        <Field hint="Để trống để dùng HEAD." label="Nhánh hoặc revision">
                          <Input
                            onChange={(_event, data) => setRevision(data.value)}
                            placeholder={detection?.git.branch ?? "HEAD"}
                            value={revision}
                          />
                        </Field>
                      </div>
                    </details>
                  </>
                )}
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
                  disabled={saving || !name.trim() || !repositoryPath.trim() || detecting}
                  type="submit"
                >
                  {saving ? "Đang thêm" : "Thêm dự án"}
                </Button>
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>
      <FolderBrowserDialog
        onCancel={() => setBrowsing(false)}
        onSelect={(path) => void chooseFolder(path)}
        open={browsing}
      />
    </>
  );
}
