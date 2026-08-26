import { Badge } from "@fluentui/react-components";
import {
  type PresentationTone,
  type VisualAuthority,
  visualAuthorityTone,
} from "../../domain/control-center";

const toneColor: Record<
  PresentationTone,
  "success" | "danger" | "warning" | "informative" | "subtle"
> = {
  success: "success",
  danger: "danger",
  warning: "warning",
  informative: "informative",
  subtle: "subtle",
};

export function AuthorityBadge({ authority }: { authority: VisualAuthority }) {
  return (
    <Badge appearance="outline" color={toneColor[visualAuthorityTone(authority)]}>
      {authority}
    </Badge>
  );
}

export function OutcomeBadge({
  status,
  label,
  tone,
}: {
  status: string;
  label: string;
  tone: PresentationTone;
}) {
  return (
    <Badge appearance="tint" color={toneColor[tone]} title={status}>
      {label}
    </Badge>
  );
}
