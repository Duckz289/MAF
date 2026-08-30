import { TasksApp20Regular } from "@fluentui/react-icons";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskComposer } from "../components/TaskComposer";
import type { Agent, Navigate, Project } from "../types";

export function NewTaskPage({
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
  if (!projects.length)
    return (
      <EmptyState
        actionLabel="Thêm dự án"
        description="MAF cần một đường dẫn kho mã local trước khi có thể tạo tác vụ."
        icon={<TasksApp20Regular fontSize={30} />}
        onAction={() => navigate("/projects")}
        title="Bắt đầu với một dự án"
      />
    );
  return (
    <>
      <PageHeader
        description="Mô tả kết quả cần đạt. MAF sẽ điều phối việc triển khai và chỉ bàn giao kết quả đã xác minh."
        title="Tác vụ mới"
      />
      <TaskComposer
        agents={agents}
        defaultProjectId={defaultProjectId}
        navigate={navigate}
        projects={projects}
        refresh={refresh}
      />
    </>
  );
}
