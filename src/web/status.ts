/**
 * Shared engine-state -> user-meaning translation layer. Every raw enum the backend emits
 * (quality states, trust ladder, risk levels, failure classes, merge eligibility, ...) is
 * translated here, in one place, so pages never invent their own copy for the same state and
 * never let UNKNOWN/NOT_CHECKED/NOT_REQUIRED read as a silent PASS.
 */

export type Tone = "success" | "danger" | "warning" | "informative" | "subtle";

export const qualityStateLabel = (state: string | undefined): string =>
  ({
    PASS: "Đạt",
    FAIL: "Không đạt",
    WARN: "Có cảnh báo",
    NOT_REQUIRED: "Không yêu cầu",
    NOT_CHECKED: "Chưa kiểm tra",
    UNKNOWN: "Chưa rõ",
  })[state ?? ""] ?? "Chưa kiểm tra";

/** NOT_CHECKED/NOT_REQUIRED/UNKNOWN must never render with the same tone as PASS. */
export const qualityStateTone = (state: string | undefined): Tone =>
  ({
    PASS: "success" as const,
    FAIL: "danger" as const,
    WARN: "warning" as const,
    NOT_REQUIRED: "subtle" as const,
    NOT_CHECKED: "subtle" as const,
    UNKNOWN: "subtle" as const,
  })[state ?? ""] ?? "subtle";

export const qualityDimensionLabel = (dimension: string): string =>
  ({
    Correctness: "Tính đúng đắn",
    Architecture: "Kiến trúc",
    Maintainability: "Khả năng bảo trì",
    Security: "Bảo mật",
    Performance: "Hiệu năng",
    Resilience: "Khả năng chịu lỗi",
    TestQuality: "Chất lượng kiểm thử",
    DebtDelta: "Nợ kỹ thuật",
  })[dimension] ?? dimension;

/** Dimensions shown by default even when collapsed — the rest need "Xem tất cả". */
export const primaryQualityDimensions = ["Correctness", "Security", "Performance"] as const;

export const trustStateLabel = (trustState: string | undefined, reviewRequired?: boolean): string =>
  ({
    PROPOSED: "Đang triển khai — chưa có kết quả xác minh",
    CORRECTNESS_VERIFIED: "Đúng chức năng, nhưng bằng chứng đảm bảo chưa đủ để bàn giao",
    QUALITY_VERIFIED: reviewRequired
      ? "Đã xác minh chất lượng — chờ đánh giá độc lập trước khi bàn giao"
      : "Đã xác minh chất lượng",
    DURABLE_VERIFIED: "Đã xác minh độ bền vững trước các tình huống lỗi đã kiểm tra",
    MERGE_ELIGIBLE: "Đủ điều kiện bàn giao",
  })[trustState ?? ""] ?? "Chưa có kết quả xác minh";

export const trustStateTone = (trustState: string | undefined): Tone =>
  ({
    PROPOSED: "subtle" as const,
    CORRECTNESS_VERIFIED: "warning" as const,
    QUALITY_VERIFIED: "informative" as const,
    DURABLE_VERIFIED: "informative" as const,
    MERGE_ELIGIBLE: "success" as const,
  })[trustState ?? ""] ?? "subtle";

export const riskLevelLabel = (level: string | undefined): string =>
  ({ LOW: "Thấp", MEDIUM: "Trung bình", HIGH: "Cao" })[level ?? ""] ?? "Chưa rõ";

export const riskLevelTone = (level: string | undefined): Tone =>
  ({ LOW: "subtle" as const, MEDIUM: "warning" as const, HIGH: "danger" as const })[level ?? ""] ??
  "subtle";

export const riskDimensionLabel = (dimension: string): string =>
  ({
    ReasoningDifficulty: "Độ khó lập luận",
    CodeCoupling: "Mức độ liên kết mã",
    BlastRadius: "Phạm vi ảnh hưởng",
    ArchitectureSensitivity: "Nhạy cảm kiến trúc",
    DebtRisk: "Rủi ro nợ kỹ thuật",
    SecuritySensitivity: "Nhạy cảm bảo mật",
    PerformanceSensitivity: "Nhạy cảm hiệu năng",
    OperationalSensitivity: "Nhạy cảm vận hành",
    NetworkBoundaryChanges: "Thay đổi ranh giới mạng",
    DataConsistencyRisk: "Rủi ro nhất quán dữ liệu",
  })[dimension] ?? dimension;

/** INSUFFICIENT_EVIDENCE must read as "chưa rõ", never as a quiet LOW. */
export const riskProvenanceNote = (provenance: string | undefined): string | undefined =>
  provenance === "INSUFFICIENT_EVIDENCE" ? "Chưa đủ bằng chứng để đánh giá" : undefined;

export const failureClassificationLabel = (classification: string | undefined): string =>
  ({
    PROVIDER_TRANSIENT: "Provider gián đoạn tạm thời",
    PROVIDER_DEGRADED: "Provider đang suy giảm chất lượng",
    RATE_LIMIT: "Bị giới hạn tốc độ (rate limit)",
    NETWORK_FAILURE: "Lỗi mạng",
    CREDENTIAL_FAILURE: "Lỗi xác thực credential",
    AGENT_FAILURE: "Agent gặp lỗi",
    VERIFICATION_FAILURE: "Xác minh không đạt",
    ENVIRONMENT_FAILURE: "Lỗi môi trường thực thi",
    BUDGET_EXHAUSTED: "Đã hết ngân sách",
    USER_INTERRUPT: "Bị dừng thủ công",
    REVISION_CONFLICT: "Xung đột revision",
    UNKNOWN_FAILURE: "Chưa xác định được nguyên nhân",
  })[classification ?? ""] ?? "Chưa xác định được nguyên nhân";

export const mergeEligibilityLabel = (eligibility: string | undefined): string =>
  ({
    ELIGIBLE: "Đủ điều kiện — chờ phê duyệt bên ngoài",
    PENDING: "Chờ bằng chứng CI bắt buộc",
    BLOCKED: "Bị chặn",
  })[eligibility ?? ""] ?? "Chưa rõ";

export const mergeEligibilityTone = (eligibility: string | undefined): Tone =>
  ({
    ELIGIBLE: "success" as const,
    PENDING: "informative" as const,
    BLOCKED: "danger" as const,
  })[eligibility ?? ""] ?? "subtle";

export const ciConclusionLabel = (conclusion: string | undefined): string =>
  ({
    PENDING: "Đang chạy",
    PASS: "Đạt",
    FAIL: "Không đạt",
    CANCELLED: "Đã hủy",
    NOT_CHECKED: "Chưa kiểm tra",
    NOT_REQUIRED: "Không yêu cầu",
  })[conclusion ?? ""] ?? "Chưa kiểm tra";

export const healthMetricLabel = (metric: string): string =>
  ({
    crossModuleEdges: "Liên kết giữa các module",
    importCycleCount: "Số chu trình import",
    largestCycleFiles: "Chu trình import lớn nhất",
    largestModuleFiles: "Module lớn nhất",
    moduleCount: "Số lượng module",
    fileCount: "Số lượng tệp",
    architectureViolations: "Vi phạm kiến trúc (thay đổi này)",
    unsafeTypeEscapes: "Type escape không an toàn (thay đổi này)",
    skippedTests: "Test bị bỏ qua (thay đổi này)",
    duplicatedBlocks: "Khối mã trùng lặp (thay đổi này)",
    addedImports: "Import mới thêm",
    addedPackageDependencies: "Dependency mới thêm",
    tokensPerTask: "Token trung bình mỗi tác vụ",
    retriesPerTask: "Số lần thử lại trung bình",
    toolCallsPerTask: "Số lệnh gọi công cụ trung bình",
    contextCharsPerTask: "Kích thước ngữ cảnh trung bình",
    verifierFailuresPerTask: "Số lần xác minh thất bại trung bình",
    frontierEscalationRate: "Tỷ lệ leo thang lên chế độ nghiêm ngặt hơn",
  })[metric] ?? metric;

export const healthDirectionLabel = (direction: string): string =>
  ({
    IMPROVING: "Đang cải thiện",
    DEGRADING: "Đang xuống cấp",
    FLAT: "Không đổi",
    UNKNOWN: "Chưa thể phân loại",
  })[direction] ?? "Chưa thể phân loại";

export const healthDirectionTone = (direction: string): Tone =>
  ({
    IMPROVING: "success" as const,
    DEGRADING: "danger" as const,
    FLAT: "subtle" as const,
    UNKNOWN: "subtle" as const,
  })[direction] ?? "subtle";

export const productionImpactLabel = (state: string | undefined): string =>
  ({
    STABLE: "Ổn định sau khi phát hành",
    DEGRADING: "Có phản hồi tiêu cực từ production",
    UNKNOWN: "Chưa có bằng chứng production",
  })[state ?? ""] ?? "Chưa có bằng chứng production";

/** Short, human phrases for the raw event types shown in a run's activity timeline. */
export const eventTypeLabel = (type: string): string =>
  ({
    RunCreated: "Tác vụ được tạo",
    SandboxStarted: "Chuẩn bị môi trường làm việc riêng",
    ContextBuilt: "MAF lập chỉ mục ngữ cảnh kho mã",
    ContextExpanded: "MAF mở rộng ngữ cảnh kho mã",
    ContextRebuilt: "MAF xây dựng lại ngữ cảnh kho mã",
    RiskProfiled: "MAF đánh giá rủi ro thay đổi",
    AssurancePlanned: "MAF xác định các bước xác minh cần thiết",
    DiffCaptured: "Đã ghi nhận thay đổi để xác minh",
    VerificationChanged: "Cập nhật kết quả xác minh",
    VerificationRepairStarted: "MAF thử sửa để xác minh lại",
    VerificationRepairStopped: "Dừng thử sửa lại",
    PerformanceAssessed: "Đánh giá hiệu năng",
    ResilienceAssessed: "Đánh giá khả năng chịu lỗi",
    RuntimeGraphDerived: "MAF suy ra tác động vận hành từ thay đổi",
    RuntimeSignalsObserved: "Ghi nhận tín hiệu runtime mới",
    QualityAssessed: "MAF đánh giá chất lượng thay đổi",
    IndependentReviewRequested: "Yêu cầu đánh giá độc lập",
    IndependentReviewCompleted: "Hoàn tất đánh giá độc lập",
    ModeChangeRequested: "Yêu cầu điều chỉnh mức độ giám sát",
    ModeChanged: "MAF điều chỉnh mức độ giám sát",
    ModeEnforcementDeferred: "Hoãn áp dụng điều chỉnh giám sát",
    ModeEnforcementSuperseded: "Điều chỉnh giám sát bị thay thế bởi quyết định mới hơn",
    ModeEnforcementNoop: "Không cần thay đổi mức giám sát",
    BudgetAllocated: "Đã xác định ngân sách cho tác vụ",
    CostEstimated: "MAF ước tính chi phí",
    ImplausibleCostIgnored: "Bỏ qua chi phí agent tự báo cáo vì không hợp lý",
    DeliveryHandoffCreated: "Đã bàn giao để phê duyệt bên ngoài",
    DeliveryHandoffFailed: "Không thể tạo bàn giao",
    RecoveryAttempted: "MAF thử khôi phục sau gián đoạn",
    SandboxFinalized: "Hoàn tất môi trường làm việc riêng",
    SandboxCleanupFailed: "Không thể dọn dẹp môi trường làm việc riêng",
    RunPaused: "Tác vụ tạm dừng — trạng thái đã được lưu",
    RunCompleted: "Tác vụ hoàn tất",
    RunFailed: "Tác vụ không hoàn tất",
    RunCancelled: "Tác vụ đã hủy",
  })[type] ?? type;
