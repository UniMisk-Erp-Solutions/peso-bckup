import { useQuery } from "@tanstack/react-query";
import { fetchOrgMembershipRolesMap } from "@/lib/orgUsers";

export function useOrgMembershipRoles(organizationId: string | null | undefined) {
  return useQuery({
    queryKey: ["org-membership-roles", organizationId],
    queryFn: () => fetchOrgMembershipRolesMap(organizationId!),
    enabled: Boolean(organizationId),
    staleTime: 5 * 60 * 1000,
  });
}
