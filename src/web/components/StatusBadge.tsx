import { Badge } from "@fluentui/react-components";
import {
  CheckmarkCircle20Regular,
  Clock20Regular,
  DismissCircle20Regular,
  ErrorCircle20Regular,
  QuestionCircle20Regular,
} from "@fluentui/react-icons";
import type { ReactElement } from "react";
import type { Run } from "../types";
import { translatedValue } from "../utils";

type BadgeColor = "success" | "danger" | "warning" | "informative" | "subtle";

const statusAppearance = (status: string): { color: BadgeColor; icon: ReactElement } => {
  if (
    status === "VERIFIED" ||
    status === "CONNECTED" ||
    status === "CLI_READY" ||
    status === "AVAILABLE" ||
    status === "CONFIGURED"
  )
    return { color: "success", icon: <CheckmarkCircle20Regular /> };
  if (status === "FAILED" || status === "STUCK" || status === "ERROR" || status === "LOGIN_FAILED")
    return { color: "danger", icon: <ErrorCircle20Regular /> };
  if (
    status === "UNAVAILABLE" ||
    status === "AUTHENTICATION_REQUIRED" ||
    status === "AUTH_UNVERIFIED" ||
    status === "OAUTH_CONFIGURATION_REQUIRED" ||
    status === "AUTHENTICATION_FAILED" ||
    status === "ENDPOINT_UNREACHABLE" ||
    status === "PROTOCOL_INCOMPATIBLE" ||
    status === "CLI_UNAVAILABLE" ||
    status === "LOGIN_CANCELLED" ||
    status === "LOGIN_EXPIRED" ||
    status === "PAUSED"
  )
    return { color: "warning", icon: <DismissCircle20Regular /> };
  if (status === "ASSURANCE_BLOCKED" || status === "AWAITING_REVIEW")
    return { color: "warning", icon: <QuestionCircle20Regular /> };
  if (
    status === "RUNNING" ||
    status === "QUEUED" ||
    status === "STARTING_LOGIN" ||
    status === "WAITING_FOR_USER" ||
    status === "VERIFYING"
  )
    return { color: "informative", icon: <Clock20Regular /> };
  return { color: "subtle", icon: <QuestionCircle20Regular /> };
};

export function StatusBadge({ label, status }: { label?: string | undefined; status: string }) {
  const appearance = statusAppearance(status);
  return (
    <Badge appearance="tint" color={appearance.color} icon={appearance.icon}>
      {label ?? translatedValue(status)}
    </Badge>
  );
}

export function RunStatusBadge({ run }: { run: Run }) {
  const status = run.operationalStatus ?? run.state;
  return <StatusBadge status={status} />;
}
