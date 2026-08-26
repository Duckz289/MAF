import { makeStyles, Text, Title1 } from "@fluentui/react-components";
import type { ReactNode } from "react";

const useStyles = makeStyles({
  header: {
    minHeight: "62px",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: "24px",
    marginBottom: "26px",
    "@media (max-width: 700px)": { flexDirection: "column", gap: "14px" },
  },
  copy: { minWidth: 0, display: "grid", gap: "5px" },
  title: { fontSize: "30px", lineHeight: "38px", letterSpacing: "-.025em" },
  description: { maxWidth: "68ch", color: "#9ca5af", lineHeight: "21px" },
  actions: { display: "flex", gap: "8px", flexWrap: "wrap" },
});

export function PageHeader({
  actions,
  description,
  title,
}: {
  actions?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}) {
  const styles = useStyles();
  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <Title1 className={styles.title}>{title}</Title1>
        {description ? <Text className={styles.description}>{description}</Text> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
