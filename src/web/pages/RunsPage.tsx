import { Tab, TabList, makeStyles } from "@fluentui/react-components";
import { TasksApp20Regular } from "@fluentui/react-icons";
import { useState } from "react";
import type { Navigate, Run } from "../types";
import { matchesRunFilter } from "../presentation";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { TaskList } from "../components/TaskRow";

const useStyles = makeStyles({
  filters: { marginBottom: "18px", borderBottom: "1px solid #252b31" },
});

export function RunsPage({ navigate, runs }: { navigate: Navigate; runs: Run[] }) {
  const styles = useStyles();
  const [filter, setFilter] = useState("ALL");
  const filtered = runs.filter((run) => matchesRunFilter(run, filter));
  return (
    <>
      <PageHeader
        description="Theo dõi tiến độ, kết quả xác minh và các tác vụ cần bạn xử lý."
        title="Tác vụ"
      />
      <TabList
        className={styles.filters}
        selectedValue={filter}
        onTabSelect={(_event, data) => setFilter(String(data.value))}
      >
        <Tab value="ALL">Tất cả</Tab>
        <Tab value="ACTIVE">Đang chạy</Tab>
        <Tab value="ATTENTION">Cần chú ý</Tab>
        <Tab value="VERIFIED">Đã xác minh</Tab>
      </TabList>
      {filtered.length ? (
        <TaskList navigate={navigate} runs={filtered} />
      ) : (
        <EmptyState
          actionLabel={runs.length ? undefined : "Tạo tác vụ"}
          description={
            runs.length
              ? "Không có tác vụ nào khớp với bộ lọc này."
              : "Mô tả một thay đổi kỹ thuật để bắt đầu theo dõi công việc."
          }
          icon={<TasksApp20Regular fontSize={30} />}
          onAction={runs.length ? undefined : () => navigate("/runs/new")}
          title={runs.length ? "Không có kết quả" : "Chưa có tác vụ"}
        />
      )}
    </>
  );
}
