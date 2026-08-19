import { Skeleton, SkeletonItem, makeStyles } from "@fluentui/react-components";

const useStyles = makeStyles({
  root: { display: "grid", gap: "22px" },
  header: { display: "grid", gap: "10px", maxWidth: "560px" },
  grid: { display: "grid", gridTemplateColumns: "1.35fr .65fr", gap: "18px" },
  block: { height: "220px", borderRadius: "12px" },
  row: { height: "78px", borderRadius: "8px" },
});

export function LoadingState() {
  const styles = useStyles();
  return (
    <Skeleton className={styles.root} aria-label="Đang tải không gian làm việc">
      <div className={styles.header}>
        <SkeletonItem size={32} />
        <SkeletonItem size={16} />
      </div>
      <div className={styles.grid}>
        <SkeletonItem className={styles.block} />
        <SkeletonItem className={styles.block} />
      </div>
      <SkeletonItem className={styles.row} />
      <SkeletonItem className={styles.row} />
    </Skeleton>
  );
}
