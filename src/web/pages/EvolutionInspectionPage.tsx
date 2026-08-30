import { makeStyles, Text, Title2 } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import type { EvolutionInspection } from "../../domain/control-center";
import { PageHeader } from "../components/PageHeader";
import { readJson } from "../utils";

const useStyles = makeStyles({
  panel: {
    padding: "18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "10px",
  },
  quiet: { color: "#7f8a96" },
});

export function EvolutionInspectionPage() {
  const styles = useStyles();
  const [inspection, setInspection] = useState<EvolutionInspection>();
  useEffect(() => {
    void readJson<EvolutionInspection>("/api/v1/control-center/evolution").then(setInspection);
  }, []);
  return (
    <>
      <PageHeader
        description="Inspection only. There is no control that automatically optimizes production policy."
        title="Evolution"
      />
      <section className={styles.panel}>
        <Title2>Production baseline</Title2>
        <Text>{inspection?.productionBaseline?.id ?? "None recorded"}</Text>
        <Title2>Challenger</Title2>
        <Text>{inspection?.challenger?.id ?? "None recorded"}</Text>
        <Title2>Shadow / promotion</Title2>
        <Text>
          {inspection?.shadowStatus} · {inspection?.promotion}
        </Text>
        <Text className={styles.quiet}>
          Frozen suite: {inspection?.frozenSuite?.id ?? "none"}. One-click production optimization
          is not available.
        </Text>
      </section>
    </>
  );
}
