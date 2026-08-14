import { RoleBadge } from "@/components/RoleBadge";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { formatRoleLabel, normalizeOrgRole } from "@/lib/roleDisplayConfig";

type RoleBadgeWithLabelsProps = {
  role: string;
  className?: string;
  showIcon?: boolean;
  size?: "sm" | "md";
};

export function RoleBadgeWithLabels({
  role,
  className,
  showIcon = true,
  size = "sm",
}: RoleBadgeWithLabelsProps) {
  const { labelFor } = useOrganizationRoleLabels();
  const key = normalizeOrgRole(role);
  const label = key ? labelFor(key) : formatRoleLabel(role);

  return (
    <RoleBadge
      role={role}
      label={label}
      className={className}
      showIcon={showIcon}
      size={size}
    />
  );
}
