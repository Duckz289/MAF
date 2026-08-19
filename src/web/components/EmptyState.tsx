import { Button, Text, Title2, makeStyles } from "@fluentui/react-components";
import type { ReactNode } from "react";

const useStyles = makeStyles({
  root: {
    minHeight: "150px",
    padding: "28px",
    border: "1px solid #242a30",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
  },
  content: { maxWidth: "440px", display: "grid", justifyItems: "center", gap: "9px" },
  icon: { color: "#6d7884", marginBottom: "4px" },
  title: { fontSize: "19px", lineHeight: "26px" },
  body: { color: "#98a2ad", lineHeight: "21px" },
  action: { marginTop: "8px" },
});

export function EmptyState({
  actionLabel,
  description,
  icon,
  onAction,
  title,
}: {
  actionLabel?: string | undefined;
  description: string;
  icon?: ReactNode | undefined;
  onAction?: (() => void) | undefined;
  title: string;
}) {
  const styles = useStyles();
  return (
    <div className={styles.root}>
      <div className={styles.content}>
        {icon ? <span className={styles.icon}>{icon}</span> : null}
        <Title2 className={styles.title}>{title}</Title2>
        <Text className={styles.body}>{description}</Text>
        {actionLabel && onAction ? (
          <Button appearance="primary" className={styles.action} onClick={onAction}>
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
