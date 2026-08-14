import { supabase } from "@/integrations/supabase/client";
import type { TeamContext } from "@/lib/approvalHierarchy";

export async function fetchTeamForUser(
  organizationId: string,
  userId: string,
): Promise<TeamContext | null> {
  const { data: membership, error: memErr } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (memErr || !membership?.team_id) return null;

  const { data: team, error: teamErr } = await supabase
    .from("teams")
    .select(
      "id, name, routing_mode, team_leader_user_id, executive_user_id, manager_user_id",
    )
    .eq("id", membership.team_id)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (teamErr || !team) return null;

  return {
    id: team.id,
    name: team.name,
    routing_mode: team.routing_mode as TeamContext["routing_mode"],
    team_leader_user_id: team.team_leader_user_id,
    executive_user_id: team.executive_user_id,
    manager_user_id: team.manager_user_id,
  };
}

export async function fetchFirstAdminUserId(organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("organization_memberships")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return data?.user_id ?? null;
}
