import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { RoleSelectOption } from "@/components/RoleSelectOption";
import {
  isRoleEnabledInForm,
  USER_FORM_ROLE_ORDER,
  type OrgRoleKey,
} from "@/lib/roleDisplayConfig";

type RoleSelectItemsProps = {
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
};

export function RoleSelectItems({
  teamLeaderTierEnabled,
  executiveTierEnabled,
}: RoleSelectItemsProps) {
  const { labelFor } = useOrganizationRoleLabels();

  const labelOverride = (role: OrgRoleKey) => {
    if (role === "engineer") return labelFor("engineer");
    if (role === "team_leader") return labelFor("team_leader");
    if (role === "executive") return labelFor("executive");
    if (role === "admin") return labelFor("admin");
    if (role === "employee") return labelFor("employee");
    return undefined;
  };

  return (
    <>
      {USER_FORM_ROLE_ORDER.filter((role) =>
        isRoleEnabledInForm(role, { teamLeaderTierEnabled, executiveTierEnabled }),
      ).map((role) => (
        <RoleSelectOption
          key={role}
          role={role}
          labelOverride={labelOverride(role)}
        />
      ))}
    </>
  );
}
