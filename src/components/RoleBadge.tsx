import { cn } from "@/lib/utils";
import { formatRoleLabel, getRoleDisplayConfig } from "@/lib/roleDisplayConfig";

type RoleBadgeProps = {
  role: string;
  label?: string;
  className?: string;
  showIcon?: boolean;
  size?: "sm" | "md";
};

export function RoleBadge({
  role,
  label,
  className,
  showIcon = true,
  size = "sm",
}: RoleBadgeProps) {
  const config = getRoleDisplayConfig(role);
  const Icon = config.Icon;
  const text = label ?? formatRoleLabel(role);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border font-medium",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm",
        config.badgeClass,
        className,
      )}
    >
      {showIcon ? <Icon className={size === "sm" ? "h-3 w-3 shrink-0" : "h-4 w-4 shrink-0"} /> : null}
      <span className="truncate">{text}</span>
    </span>
  );
}
