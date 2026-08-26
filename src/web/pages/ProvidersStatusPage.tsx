import { Button, makeStyles, Text, Title2 } from "@fluentui/react-components";
import { useEffect, useState } from "react";
import type { OptionalProviderStatus } from "../../domain/control-center";
import { OutcomeBadge } from "../components/AuthorityBadge";
import { PageHeader } from "../components/PageHeader";
import type { Navigate } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: "12px",
    "@media (max-width: 800px)": { gridTemplateColumns: "1fr" },
  },
  card: {
    padding: "18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "8px",
  },
  quiet: { color: "#7f8a96" },
});

export function ProvidersStatusPage({ navigate }: { navigate: Navigate }) {
  const styles = useStyles();
  const [providers, setProviders] = useState<OptionalProviderStatus[]>([]);
  useEffect(() => {
    void readJson<OptionalProviderStatus[]>("/api/v1/control-center/providers").then(setProviders);
  }, []);
  return (
    <>
      <PageHeader
        description="Optional capabilities. Unavailable here does not mean MAF itself is unhealthy."
        title="Engineering providers"
        actions={
          <Button appearance="secondary" onClick={() => navigate("/connections")}>
            Agent connections
          </Button>
        }
      />
      <div className={styles.grid}>
        {providers.map((provider) => (
          <article className={styles.card} key={provider.id}>
            <Title2>{provider.name}</Title2>
            <OutcomeBadge
              label={provider.availability}
              status={provider.availability}
              tone={provider.availability === "AVAILABLE" ? "success" : "subtle"}
            />
            <Text className={styles.quiet}>{provider.scope}</Text>
            <Text size={200}>Version {provider.version ?? "unknown"}</Text>
            <Text size={200}>{provider.coverageLimitations.join(" · ")}</Text>
            {provider.failure ? <Text>{provider.failure}</Text> : null}
            <Text className={styles.quiet} size={200}>
              System health impact: {provider.systemHealthImpact}
            </Text>
          </article>
        ))}
      </div>
    </>
  );
}
