import { Button, Field, Input, makeStyles, Text, Title2 } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import type { PageResult } from "../../domain/control-center";
import type { WorkItem } from "../../domain/work";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import type { Navigate, Project } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  list: { display: "grid", gap: "10px" },
  item: {
    padding: "16px 18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "6px",
  },
  form: { display: "grid", gap: "10px", maxWidth: "520px" },
  quiet: { color: "#7f8a96" },
});

export function WorkItemsPage({ navigate, projects }: { navigate: Navigate; projects: Project[] }) {
  const styles = useStyles();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [title, setTitle] = useState("");
  const projectId = projects[0]?.id;

  useEffect(() => {
    void readJson<PageResult<WorkItem>>("/api/v1/control-center/work-items?limit=40")
      .then((page) => setItems(page.items))
      .catch(() => setItems([]));
  }, []);

  return (
    <>
      <PageHeader
        description="Minimum work coordination. External PM systems may supply status later; they cannot set trust."
        title="Work"
      />
      {projectId ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void fetch("/api/v1/control-center/work-items", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, title }),
            }).then(async () => {
              setTitle("");
              const page = await readJson<PageResult<WorkItem>>(
                "/api/v1/control-center/work-items?limit=40",
              );
              setItems(page.items);
            });
          }}
        >
          <Field label="New work item">
            <Input value={title} onChange={(_event, data) => setTitle(data.value)} />
          </Field>
          <Button appearance="primary" disabled={!title.trim()} type="submit">
            Capture work
          </Button>
        </form>
      ) : (
        <EmptyState
          actionLabel="Add a project"
          description="Work items belong to a MAF project."
          onAction={() => navigate("/projects")}
          title="No project yet"
        />
      )}
      <div className={styles.list} style={{ marginTop: 18 }}>
        {items.map((item) => (
          <article className={styles.item} key={item.id}>
            <Title2>{item.title}</Title2>
            <Text>
              {item.status} · {item.priority} · {item.provider}
            </Text>
            <Text className={styles.quiet}>
              {item.runId ? `Linked run ${item.runId}` : "Not yet linked to a MAF run"}
            </Text>
          </article>
        ))}
      </div>
    </>
  );
}
