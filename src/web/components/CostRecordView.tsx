import { makeStyles, Text } from "@fluentui/react-components";
import type { CostPresentation } from "../../domain/control-center";

const useStyles = makeStyles({
  root: { display: "grid", gap: "6px" },
  total: { fontSize: "22px", lineHeight: "28px", letterSpacing: "-.02em" },
  unknown: { color: "#c9a227" },
  quiet: { color: "#7f8a96" },
  row: {
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    color: "#b6bec7",
  },
});

export function CostRecordView({ cost }: { cost: CostPresentation }) {
  const styles = useStyles();
  const unknown = cost.total.status === "UNKNOWN" || cost.total.status === "SUBSCRIPTION_INCLUDED";
  return (
    <div className={styles.root}>
      <Text className={unknown ? styles.unknown : styles.total} weight="semibold">
        {cost.total.display}
      </Text>
      <Text className={styles.quiet} size={200}>
        {cost.total.status}
        {cost.unknownComponentCount > 0
          ? ` · ${cost.unknownComponentCount} unknown component(s)`
          : ""}
        {cost.knownSubtotalUsd > 0 ? ` · known subtotal $${cost.knownSubtotalUsd.toFixed(2)}` : ""}
      </Text>
      {cost.components.map((component) => (
        <div className={styles.row} key={component.id}>
          <span>{component.id}</span>
          <span>{component.monetary.display}</span>
        </div>
      ))}
      <Text className={styles.quiet} size={200}>
        Cost per durable verified success is not claimed until DVS evaluation data exists.
      </Text>
    </div>
  );
}
