import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  makeStyles,
  Select,
  Text,
  Textarea,
} from "@fluentui/react-components";
import {
  ChevronDown20Regular,
  Info20Regular,
  Play20Regular,
  ShieldCheckmark20Regular,
} from "@fluentui/react-icons";
import { type FormEvent, useEffect, useState } from "react";
import { qualityPreferenceDescription } from "../presentation";
import type { Agent, Navigate, Project, Run } from "../types";

const useStyles = makeStyles({
  composer: {
    width: "min(940px, 100%)",
    margin: "18px auto 0",
    border: "1px solid #343b43",
    borderRadius: "12px",
    backgroundColor: "#111315",
    boxShadow: "0 24px 70px rgba(0, 0, 0, .22)",
    overflow: "hidden",
  },
  promptField: { padding: "24px 24px 12px" },
  prompt: {
    minHeight: "160px",
    fontSize: "18px",
    lineHeight: "28px",
    backgroundColor: "transparent",
    border: 0,
    ":focus-within": { outline: "none" },
  },
  controls: {
    padding: "17px 20px",
    borderTop: "1px solid #252b31",
    backgroundColor: "#14171a",
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(120px, 1fr)) auto",
    gap: "12px",
    alignItems: "end",
    "@media (max-width: 1000px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  control: { minWidth: 0 },
  select: { width: "100%" },
  runButton: { minWidth: "126px", "@media (max-width: 1000px)": { justifySelf: "start" } },
  preferenceNote: {
    padding: "10px 20px",
    display: "flex",
    alignItems: "center",
    gap: "9px",
    color: "#858f9a",
    borderTop: "1px solid #20252a",
  },
  advancedToggle: {
    width: "min(940px, 100%)",
    margin: "12px auto 0",
    display: "flex",
    justifyContent: "flex-start",
  },
  advanced: {
    width: "min(940px, 100%)",
    margin: "10px auto 0",
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#0f1113",
    display: "grid",
    gap: "18px",
  },
  advancedGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "16px",
    "@media (max-width: 650px)": { gridTemplateColumns: "1fr" },
  },
  error: { width: "min(940px, 100%)", margin: "12px auto 0" },
});

export function TaskComposer({
  agents,
  defaultProjectId,
  navigate,
  projects,
  refresh,
}: {
  agents: Agent[];
  defaultProjectId?: string | undefined;
  navigate: Navigate;
  projects: Project[];
  refresh: () => Promise<void>;
}) {
  const styles = useStyles();
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState("BALANCED");
  const [qualityTouched, setQualityTouched] = useState(false);
  const [budgetChoice, setBudgetChoice] = useState<"AUTOMATIC" | "CUSTOM">("AUTOMATIC");
  const [customBudget, setCustomBudget] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState("AUTO");
  const [modeTouched, setModeTouched] = useState(false);
  const [revision, setRevision] = useState("");
  const [verification, setVerification] = useState("");
  const [expectedFile, setExpectedFile] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const activeAgent = agents.find((agent) => agent.active);
  const selectedProject = projects.find((project) => project.id === projectId) ?? projects[0];

  useEffect(() => {
    if (!selectedProject) return;
    if (!revision) setRevision(selectedProject.revision);
    if (!qualityTouched && selectedProject.preferences.qualityPreference) {
      setQuality(selectedProject.preferences.qualityPreference);
    }
    if (!modeTouched && selectedProject.preferences.executionModePreference) {
      setMode(selectedProject.preferences.executionModePreference);
    }
  }, [revision, selectedProject, qualityTouched, modeTouched]);

  const startTask = async () => {
    if (!selectedProject) return;
    setRunning(true);
    setError(undefined);
    try {
      const customLimit = budgetChoice === "CUSTOM" ? Number(customBudget) : undefined;
      const projectLimit = selectedProject.preferences.budgetLimitUsd;
      const budgetPayload =
        customLimit !== undefined && Number.isFinite(customLimit) && customLimit > 0
          ? { mode: selectedProject.preferences.budgetMode ?? "ADVISORY", limitUsd: customLimit }
          : budgetChoice === "AUTOMATIC" && projectLimit !== undefined
            ? { mode: selectedProject.preferences.budgetMode ?? "ADVISORY", limitUsd: projectLimit }
            : undefined;
      const response = await fetch("/api/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          repositoryPath: selectedProject.repositoryPath,
          revision: revision.trim() || selectedProject.revision,
          ...(mode !== "AUTO" ? { mode } : {}),
          qualityPreference: quality,
          ...(budgetPayload ? { budget: budgetPayload } : {}),
          ...(verification.trim() || expectedFile.trim()
            ? {
                verification: {
                  ...(verification.trim() ? { command: verification.trim() } : {}),
                  ...(expectedFile.trim() ? { expectedFile: expectedFile.trim() } : {}),
                },
              }
            : {}),
          ...(credentialReference.trim()
            ? { credentialReferences: [credentialReference.trim()] }
            : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => undefined)) as
          | { message?: string }
          | undefined;
        throw new Error(body?.message ?? `Khởi tạo tác vụ trả về ${response.status}`);
      }
      const run = (await response.json()) as Run;
      await refresh();
      navigate(`/runs/${run.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void startTask();
  };

  return (
    <form onSubmit={submit}>
      <div className={styles.composer}>
        <div className={styles.promptField}>
          <Field label="Bạn muốn MAF xây dựng hoặc sửa gì?" required>
            <Textarea
              aria-label="Mô tả tác vụ"
              autoFocus
              className={styles.prompt}
              placeholder="Ví dụ: sửa phân quyền chia sẻ notebook và thêm test hồi quy..."
              resize="vertical"
              value={prompt}
              onChange={(_event, data) => setPrompt(data.value)}
            />
          </Field>
        </div>
        <div className={styles.controls}>
          <Field className={styles.control} label="Dự án" size="small">
            <Select
              className={styles.select}
              value={selectedProject?.id ?? ""}
              onChange={(_event, data) => {
                const project = projects.find((candidate) => candidate.id === data.value);
                setProjectId(data.value);
                if (project) setRevision(project.revision);
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field className={styles.control} label="Ưu tiên chất lượng" size="small">
            <Select
              className={styles.select}
              value={quality}
              onChange={(_event, data) => {
                setQualityTouched(true);
                setQuality(data.value);
              }}
            >
              <option value="FAST">Nhanh</option>
              <option value="BALANCED">Cân bằng</option>
              <option value="HIGH">Cao</option>
              <option value="CRITICAL">Rất cao</option>
            </Select>
          </Field>
          <Field className={styles.control} label="Agent" size="small">
            <Select className={styles.select} value="AUTO">
              <option value="AUTO">
                {activeAgent ? `Tự động: ${activeAgent.name}` : "Tự động"}
              </option>
            </Select>
          </Field>
          <Field className={styles.control} label="Ngân sách" size="small">
            <Select
              className={styles.select}
              value={budgetChoice}
              onChange={(_event, data) => setBudgetChoice(data.value as "AUTOMATIC" | "CUSTOM")}
            >
              <option value="AUTOMATIC">Tự động</option>
              <option value="CUSTOM">Tùy chỉnh</option>
            </Select>
          </Field>
          <Button
            appearance="primary"
            className={styles.runButton}
            disabled={running || !prompt.trim()}
            icon={<Play20Regular />}
            type="submit"
          >
            {running ? "Đang chạy" : "Chạy tác vụ"}
          </Button>
        </div>
        {budgetChoice === "CUSTOM" ? (
          <div className={styles.controls} style={{ gridTemplateColumns: "1fr", paddingTop: 0 }}>
            <Field
              hint="MAF giữ trong giới hạn này và dành riêng phần cần thiết cho xác minh."
              label="Giới hạn tối đa cho tác vụ này ($)"
            >
              <Input
                onChange={(_event, data) => setCustomBudget(data.value)}
                placeholder="1.00"
                type="number"
                value={customBudget}
              />
            </Field>
          </div>
        ) : null}
        <div className={styles.preferenceNote}>
          <Info20Regular />
          <Text size={200}>
            {qualityPreferenceDescription(quality)}{" "}
            {selectedProject?.preferences.budgetLimitUsd !== undefined &&
            budgetChoice === "AUTOMATIC"
              ? `Ngân sách tự động dùng mặc định của dự án: $${selectedProject.preferences.budgetLimitUsd.toFixed(2)}.`
              : budgetChoice === "AUTOMATIC"
                ? "Chưa đặt giới hạn ngân sách — tác vụ không bị chặn bởi ngân sách."
                : ""}
          </Text>
        </div>
      </div>
      <div className={styles.advancedToggle}>
        <Button
          appearance="subtle"
          icon={
            <ChevronDown20Regular style={{ transform: advanced ? "rotate(180deg)" : undefined }} />
          }
          onClick={() => setAdvanced((value) => !value)}
          type="button"
        >
          Nâng cao
        </Button>
      </div>
      {advanced ? (
        <section className={styles.advanced} aria-label="Cài đặt tác vụ nâng cao">
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <ShieldCheckmark20Regular />
            <Text style={{ color: "#9ca5af" }}>
              Chỉ các trường runtime đang hỗ trợ mới được gửi tới server.
            </Text>
          </div>
          <div className={styles.advancedGrid}>
            <Field
              label="Chế độ thực thi"
              hint="Tự động để MAF chọn dựa trên tín hiệu có bằng chứng."
            >
              <Select
                value={mode}
                onChange={(_event, data) => {
                  setModeTouched(true);
                  setMode(data.value);
                }}
              >
                <option value="AUTO">Tự động</option>
                <option value="STRICT">STRICT</option>
                <option value="GUIDED">GUIDED</option>
                <option value="SOLO_NATIVE">SOLO_NATIVE</option>
              </Select>
            </Field>
            <Field label="Revision">
              <Input value={revision} onChange={(_event, data) => setRevision(data.value)} />
            </Field>
            <Field label="Lệnh xác minh">
              <Input
                placeholder="npm test"
                value={verification}
                onChange={(_event, data) => setVerification(data.value)}
              />
            </Field>
            <Field label="Tệp mong đợi">
              <Input
                placeholder="src/feature.ts"
                value={expectedFile}
                onChange={(_event, data) => setExpectedFile(data.value)}
              />
            </Field>
          </div>
          <Field
            label="Tham chiếu credential"
            hint="Chỉ nhận credential://. Không dán API key thô vào đây."
            validationState={
              credentialReference && !credentialReference.startsWith("credential://")
                ? "error"
                : "none"
            }
            {...(credentialReference && !credentialReference.startsWith("credential://")
              ? { validationMessage: "Tham chiếu phải bắt đầu bằng credential://" }
              : {})}
          >
            <Input
              placeholder="credential://user/provider/default"
              value={credentialReference}
              onChange={(_event, data) => setCredentialReference(data.value)}
            />
          </Field>
        </section>
      ) : null}
      {error ? (
        <MessageBar className={styles.error} intent="error">
          <MessageBarBody>
            MAF không thể khởi chạy tác vụ.
            <details>
              <summary>Chi tiết kỹ thuật</summary>
              {error}
            </details>
          </MessageBarBody>
        </MessageBar>
      ) : null}
    </form>
  );
}
