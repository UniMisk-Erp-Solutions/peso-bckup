import { SelectItem } from "@/components/ui/select";
import {
  formatRoleLabel,
  getRoleDisplayConfig,
  type OrgRoleKey,
} from "@/lib/roleDisplayConfig";

type RoleSelectOptionProps = {
  role: OrgRoleKey;
  labelOverride?: string;
  descriptionOverride?: string;
};

export function RoleSelectOption({
  role,
  labelOverride,
  descriptionOverride,
}: RoleSelectOptionProps) {
  const config = getRoleDisplayConfig(role);
  const Icon = config.Icon;
  const label = labelOverride ?? formatRoleLabel(role);
  const description = descriptionOverride ?? config.description;

  return (
    <SelectItem value={role}>
      <div className="flex items-center gap-3 py-2">
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${config.iconBg}`}
        >
          <Icon className={`h-4 w-4 ${config.iconColor}`} />
        </div>
        <div className="min-w-0 text-left">
          <div className="font-medium">{label}</div>
          {description ? (
            <div className="text-xs text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
    </SelectItem>
  );
}
