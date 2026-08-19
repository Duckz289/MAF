import type { Run } from "./types";

export const isNavigationSelected = (path: string, href: string) =>
  href === "/" ? path === "/" : path.startsWith(href);

export const matchesRunFilter = (run: Run, filter: string) => {
  if (filter === "ACTIVE") return run.state === "RUNNING" || run.state === "QUEUED";
  if (filter === "ATTENTION") return run.state === "FAILED" || run.operationalStatus === "STUCK";
  if (filter === "VERIFIED") return run.verificationState === "VERIFIED";
  return true;
};

export const qualityPreferenceDescription = (quality: string) =>
  ({
    FAST: "Ưu tiên tốc độ và chi phí thấp.",
    BALANCED: "Mặc định phù hợp cho công việc hằng ngày.",
    HIGH: "Ưu tiên lập luận và xác minh kỹ hơn.",
    CRITICAL: "Dành cho thay đổi nhạy cảm hoặc rủi ro cao.",
  })[quality] ?? "Đây là ưu tiên giao diện, chưa phải cam kết thực thi.";

export const connectionStatusLabel = (status: string, checked: boolean) => {
  if (status === "UNKNOWN") return checked ? "Đã tìm thấy CLI" : "Chưa kiểm tra";
  return undefined;
};
