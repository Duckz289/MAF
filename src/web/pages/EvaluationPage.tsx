import { Badge, makeStyles, Text } from "@fluentui/react-components";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { qualityStateLabel, qualityStateTone } from "../status";
import type { Project, Run } from "../types";
import { formatCost } from "../utils";

const useStyles = makeStyles({
  page: { display: "grid", gap: "18px" },
  note: {
    padding: "12px 16px",
    border: "1px solid #29313a",
    borderRadius: "10px",
    backgroundColor: "#12161a",
    color: "#8d97a2",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: "14px",
  },
  card: {
    padding: "20px",
    border: "1px solid #252b31",
    borderRadius: "12px",
    backgroundColor: "#111315",
    display: "grid",
    gap: "14px",
  },
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "10px" },
  metric: { display: "grid", gridTemplateColumns: "1fr auto", gap: "10px", alignItems: "center" },
  quiet: { color: "#7f8a96" },
  breakdown: { display: "flex", gap: "6px", flexWrap: "wrap" },
});

interface StrategyGroup {
  key: string;
  provider: string;
  model: string;
  samples: NonNullable<Run["strategyObservationBinding"]>[];
}

const groupByStrategy = (runs: Run[]): StrategyGroup[] => {
  const groups = new Map<string, StrategyGroup>();
  for (const run of runs) {
    const binding = run.strategyObservationBinding;
    if (!binding) continue;
    const key = `${run.provider}:${run.model}`;
    const group = groups.get(key) ?? { key, provider: run.provider, model: run.model, samples: [] };
    group.samples.push(binding);
    groups.set(key, group);
  }
  return [...groups.values()].toSorted((a, b) => b.samples.length - a.samples.length);
};

const rate = (samples: unknown[], matches: number): string =>
  samples.length ? `${Math.round((matches / samples.length) * 100)}%` : "Chưa rõ";

const outcomeCounts = (
  samples: NonNullable<Run["strategyObservationBinding"]>[],
  field: "security" | "performance" | "resilience",
) => {
  const counts: Record<string, number> = {};
  for (const sample of samples) counts[sample[field]] = (counts[sample[field]] ?? 0) + 1;
  return counts;
};

function StrategyCard({ group }: { group: StrategyGroup }) {
  const styles = useStyles();
  const { samples } = group;
  const verified = samples.filter((sample) => sample.verifiedSuccess).length;
  const knownCost = samples.filter((sample) => sample.costUsd !== null);
  const avgCost = knownCost.length
    ? knownCost.reduce((sum, sample) => sum + (sample.costUsd ?? 0), 0) / knownCost.length
    : undefined;
  const stable = samples.filter((sample) => sample.healthEffect === "STABLE").length;
  const insufficientEvidence = samples.length < 3;
  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div>
          <Text weight="semibold">{group.provider}</Text>
          <Text block className={styles.quiet} size={200}>
            {group.model}
          </Text>
        </div>
        <Badge appearance="tint">{samples.length} lần chạy có bằng chứng</Badge>
      </div>
      {insufficientEvidence ? (
        <Text className={styles.quiet} size={200}>
          Chưa đủ bằng chứng để so sánh — cần thêm tác vụ đã hoàn tất cho tổ hợp này.
        </Text>
      ) : (
        <>
          <div className={styles.metric}>
            <Text size={200}>Tỷ lệ xác minh thành công</Text>
            <Text weight="semibold">{rate(samples, verified)}</Text>
          </div>
          <div className={styles.metric}>
            <Text size={200}>Ổn định sau khi bàn giao</Text>
            <Text weight="semibold">{rate(samples, stable)}</Text>
          </div>
          <div className={styles.metric}>
            <Text size={200}>Chi phí trung bình</Text>
            <Text weight="semibold">
              {avgCost === undefined ? "Chưa khả dụng" : formatCost(avgCost)}
            </Text>
          </div>
          {(["security", "performance", "resilience"] as const).map((dimension) => (
            <div className={styles.metric} key={dimension}>
              <Text size={200}>
                {dimension === "security"
                  ? "Bảo mật"
                  : dimension === "performance"
                    ? "Hiệu năng"
                    : "Khả năng chịu lỗi"}
              </Text>
              <div className={styles.breakdown}>
                {Object.entries(outcomeCounts(samples, dimension)).map(([state, count]) => (
                  <Badge appearance="tint" color={qualityStateTone(state)} key={state} size="small">
                    {qualityStateLabel(state)} · {count}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </article>
  );
}

export function EvaluationPage({ projects, runs }: { projects: Project[]; runs: Run[] }) {
  const styles = useStyles();
  const groups = groupByStrategy(runs);
  return (
    <div className={styles.page}>
      <PageHeader
        description="So sánh kết quả thực tế giữa các agent/model đã dùng trong workspace này — không phải điểm benchmark giả định."
        title="Đánh giá"
      />
      {groups.length ? (
        <>
          <div className={styles.note}>
            <Text size={200}>
              Bằng chứng ghi nhận cục bộ từ {projects.length} dự án và các tác vụ đã hoàn tất trong
              workspace này — không phải kết quả benchmark production. Chạy{" "}
              <code>npm run benchmark</code> để tạo bằng chứng đối chứng có kiểm soát.
            </Text>
          </div>
          <div className={styles.grid}>
            {groups.map((group) => (
              <StrategyCard group={group} key={group.key} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          description="MAF cần thêm tác vụ đã hoàn tất và xác minh trước khi có thể so sánh hiệu quả giữa các agent/model."
          title="Chưa đủ bằng chứng để đánh giá"
        />
      )}
    </div>
  );
}
