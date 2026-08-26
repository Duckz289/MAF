import { Button, makeStyles, Text, Title2 } from "@fluentui/react-components";
import { ArrowLeft20Regular } from "@fluentui/react-icons";
import { useEffect, useState } from "react";
import type { InspectionDepth, MissionReadModel, WhyRecord } from "../../domain/control-center";
import { AuthorityBadge, OutcomeBadge } from "../components/AuthorityBadge";
import { CostRecordView } from "../components/CostRecordView";
import { EmptyState } from "../components/EmptyState";
import { InspectionDepthToggle } from "../components/InspectionDepthToggle";
import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";
import type { Navigate } from "../types";
import { readJson } from "../utils";

const useStyles = makeStyles({
  page: { display: "grid", gap: "18px" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "14px",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
  },
  panel: {
    padding: "18px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "10px",
  },
  fact: { display: "grid", gap: "4px" },
  quiet: { color: "#7f8a96" },
  why: { display: "grid", gap: "8px" },
  whyRow: { display: "grid", gap: "2px", paddingBottom: "8px", borderBottom: "1px solid #22272c" },
});

export function MissionControlPage({ navigate, runId }: { navigate: Navigate; runId: string }) {
  const styles = useStyles();
  const [depth, setDepth] = useState<InspectionDepth>("SIMPLE");
  const [mission, setMission] = useState<MissionReadModel>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void readJson<MissionReadModel>(`/api/v1/control-center/runs/${runId}?depth=${depth}`)
      .then((next) => {
        if (!cancelled) {
          setMission(next);
          setError(undefined);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      cancelled = true;
    };
  }, [depth, runId]);

  if (error) {
    return (
      <EmptyState
        actionLabel="Back to missions"
        description={error}
        onAction={() => navigate("/runs")}
        title="Mission not available"
      />
    );
  }
  if (!mission) return <LoadingState />;

  const why: WhyRecord[] = mission.depth === "INSPECT" ? mission.why : [];

  return (
    <div className={styles.page}>
      <Button appearance="subtle" icon={<ArrowLeft20Regular />} onClick={() => navigate("/runs")}>
        All missions
      </Button>
      <PageHeader
        actions={<InspectionDepthToggle onChange={setDepth} value={depth} />}
        description="Human control surface for one MAF mission. Expert detail stays hidden until requested."
        title="Mission Control"
      />
      <div className={styles.grid}>
        <section className={styles.panel}>
          <Title2>Objective</Title2>
          <Text>{mission.objective}</Text>
          <div className={styles.fact}>
            <Text className={styles.quiet} size={200}>
              Status
            </Text>
            <Text>
              {mission.status} · {mission.operationalStatus}
            </Text>
          </div>
        </section>
        <section className={styles.panel}>
          <Title2>Execution</Title2>
          <div className={styles.fact}>
            <Text className={styles.quiet} size={200}>
              Agent / model
            </Text>
            <Text>
              {mission.selectedAgent} · {mission.selectedModel}
            </Text>
          </div>
          <div className={styles.fact}>
            <Text className={styles.quiet} size={200}>
              Intervention mode
            </Text>
            <Text>{mission.interventionMode}</Text>
          </div>
          <div className={styles.fact}>
            <Text className={styles.quiet} size={200}>
              Budget
            </Text>
            <Text>
              {mission.budget.configured
                ? `${mission.budget.mode} · $${mission.budget.limitUsd}`
                : "Not configured"}
            </Text>
          </div>
        </section>
        <section className={styles.panel}>
          <Title2>Verification and trust</Title2>
          <OutcomeBadge
            label={mission.verification.label}
            status={mission.verification.state}
            tone={mission.verification.tone}
          />
          <OutcomeBadge
            label={mission.trust.label}
            status={mission.trust.state}
            tone={mission.trust.tone}
          />
          <CostRecordView cost={mission.cost} />
        </section>
      </div>
      {mission.depth !== "SIMPLE" ? (
        <section className={styles.panel}>
          <Title2>Advanced controls</Title2>
          <Text className={styles.quiet}>
            Desired {mission.desiredMode} · effective {mission.effectiveMode} · context expansion is
            bounded page requests.
          </Text>
          {mission.skills.length ? (
            mission.skills.map((skill) => (
              <Text key={skill.skillId}>
                {skill.skillId}: {skill.status} — {skill.reason}
              </Text>
            ))
          ) : (
            <Text className={styles.quiet}>No Skill selections recorded.</Text>
          )}
        </section>
      ) : null}
      {mission.depth === "INSPECT" ? (
        <>
          <section className={styles.panel}>
            <Title2>Why?</Title2>
            <div className={styles.why}>
              {why.length ? (
                why.map((record) => (
                  <div className={styles.whyRow} key={record.id}>
                    <Text weight="semibold">{record.question}</Text>
                    <Text>{record.reason}</Text>
                    <Text className={styles.quiet} size={200}>
                      {record.eventType} · recorded event · not an LLM explanation
                    </Text>
                  </div>
                ))
              ) : (
                <Text className={styles.quiet}>No recorded decision provenance yet.</Text>
              )}
            </div>
          </section>
          <section className={styles.panel}>
            <Title2>Trust derivation</Title2>
            {mission.trustDerivation.map((step) => (
              <div className={styles.whyRow} key={step.stage}>
                <Text weight="semibold">
                  {step.stage} · {step.status}
                </Text>
                <Text>{step.detail}</Text>
                <AuthorityBadge authority={step.authority} />
              </div>
            ))}
          </section>
          <section className={styles.panel}>
            <Title2>Context OS</Title2>
            <Text>
              Initial files {mission.context.initialWorkingSet.files.length} · resident pages{" "}
              {mission.context.residentPages} · expansions {mission.context.expansionEvents} · stale
              rejections {mission.context.staleRejections}
            </Text>
            <Text className={styles.quiet}>
              Project knowledge can be large; resident mission context stays small. Cold-state
              records are not shown by default.
            </Text>
          </section>
        </>
      ) : null}
      <Button appearance="secondary" onClick={() => navigate(`/runs/${runId}/raw`)}>
        Open raw run timeline
      </Button>
    </div>
  );
}
