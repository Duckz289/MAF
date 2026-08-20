import type { Run } from "./types";

export const friendlyMode = (mode: Run["executionMode"]) =>
  ({ STRICT: "Tập trung", GUIDED: "Có hướng dẫn", SOLO_NATIVE: "Tự chủ native" })[mode];

export const formatCost = (cost: number) =>
  cost > 0 ? `$${cost.toFixed(2)}` : "Chi phí chưa khả dụng";

export const translatedValue = (value: string) =>
  ({
    QUEUED: "Đang chờ",
    RUNNING: "Đang chạy",
    VERIFIED: "Đã xác minh",
    ASSURANCE_BLOCKED: "Bằng chứng chưa đủ",
    AWAITING_REVIEW: "Chờ đánh giá",
    FAILED: "Thất bại",
    CANCELLED: "Đã hủy",
    STUCK: "Cần xử lý",
    UNKNOWN: "Chưa rõ",
    UNAVAILABLE: "Không khả dụng",
    NOT_CONFIGURED: "Chưa cấu hình",
    CONNECTED: "Đã kết nối",
    "Repository and context": "Hiểu kho mã",
    "Agent execution": "Đang triển khai",
    Verification: "Đang xác minh",
    "Verified handoff": "Đã bàn giao",
    "Assurance blocked": "Bằng chứng chưa đủ để bàn giao",
    "Quarantine review": "Đang xem xét",
  })[value] ?? value;

export const formatDate = (value: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));

export const formatRelativeTime = (value: string) => {
  const seconds = Math.round((Date.now() - Date.parse(value)) / 1000);
  const formatter = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
};

export const runNeedsAttention = (run: Run) =>
  run.state === "FAILED" ||
  run.operationalStatus === "STUCK" ||
  run.operationalStatus === "ASSURANCE_BLOCKED";

export const readJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} trả về ${response.status}`);
  return response.json() as Promise<T>;
};
