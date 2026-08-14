import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Users, Plus, Pencil, Trash2, Save } from "lucide-react";
import { DEFAULT_ROLE_LABELS, type RoleLabels } from "@/lib/approvalHierarchy";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { getOrgSettings, invalidateOrgSettings } from "@/lib/orgSettingsCache";
import { fetchProfilesByUserIds } from "@/lib/supabaseInQuery";

type OrgUser = { user_id: string; name: string; role: string };

type TeamRow = {
  id: string;
  name: string;
  routing_mode: string;
  team_leader_user_id: string | null;
  executive_user_id: string | null;
  manager_user_id: string | null;
  member_count?: number;
};

const ROUTING_MODES = ["full", "skip_to_manager", "skip_to_admin"] as const;

export function TeamManagementSection() {
  const { t } = useTranslation("settings");
  const { organizationId } = useAuth();
  const { toast } = useToast();
  const { labelFor, labels, refresh: refreshLabels } = useOrganizationRoleLabels();

  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [roleLabelsDraft, setRoleLabelsDraft] = useState<RoleLabels>({ ...DEFAULT_ROLE_LABELS });
  const [savingLabels, setSavingLabels] = useState(false);

  const [form, setForm] = useState({
    name: "",
    routing_mode: "full" as (typeof ROUTING_MODES)[number],
    team_leader_user_id: "none",
    executive_user_id: "none",
    manager_user_id: "none",
    member_ids: [] as string[],
  });

  const load = useCallback(async () => {
    if (!organizationId) return;
    setLoading(true);
    const [teamsRes, membersRes, usersRes, settingsData] = await Promise.all([
      supabase.from("teams").select("*").eq("organization_id", organizationId).order("name"),
      supabase.from("team_members").select("team_id, user_id").eq("organization_id", organizationId),
      supabase
        .from("organization_memberships")
        .select("user_id, role")
        .eq("organization_id", organizationId)
        .eq("is_active", true),
      getOrgSettings(organizationId),
    ]);

    const memberCounts: Record<string, number> = {};
    for (const m of membersRes.data ?? []) {
      memberCounts[m.team_id] = (memberCounts[m.team_id] ?? 0) + 1;
    }

    setTeams(
      (teamsRes.data ?? []).map((t) => ({
        ...t,
        member_count: memberCounts[t.id] ?? 0,
      })) as TeamRow[],
    );

    const memRows = usersRes.data ?? [];
    const userIds = memRows.map((r) => r.user_id);
    let profileMap: Record<string, string> = {};
    if (userIds.length > 0 && organizationId) {
      const profiles = (await fetchProfilesByUserIds(
        supabase,
        organizationId,
        userIds,
        "user_id, name",
      )) as { user_id: string; name: string }[];
      profileMap = Object.fromEntries(
        profiles.map((p) => [p.user_id, p.name ?? "Unknown"]),
      );
    }
    setUsers(
      memRows.map((row) => ({
        user_id: row.user_id,
        name: profileMap[row.user_id] ?? "Unknown",
        role: row.role,
      })),
    );

    const raw = settingsData?.approval_hierarchy_role_labels as RoleLabels | null;
    setRoleLabelsDraft({ ...DEFAULT_ROLE_LABELS, ...(raw ?? labels ?? {}) });
    setLoading(false);
  }, [organizationId, labels]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingTeam(null);
    setForm({
      name: "",
      routing_mode: "full",
      team_leader_user_id: "none",
      executive_user_id: "none",
      manager_user_id: "none",
      member_ids: [],
    });
    setDialogOpen(true);
  };

  const openEdit = async (team: TeamRow) => {
    setEditingTeam(team);
    const { data: members } = await supabase
      .from("team_members")
      .select("user_id")
      .eq("team_id", team.id);
    setForm({
      name: team.name,
      routing_mode: team.routing_mode as (typeof ROUTING_MODES)[number],
      team_leader_user_id: team.team_leader_user_id ?? "none",
      executive_user_id: team.executive_user_id ?? "none",
      manager_user_id: team.manager_user_id ?? "none",
      member_ids: (members ?? []).map((m) => m.user_id),
    });
    setDialogOpen(true);
  };

  const saveTeam = async () => {
    if (!organizationId || !form.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        organization_id: organizationId,
        name: form.name.trim(),
        routing_mode: form.routing_mode,
        team_leader_user_id:
          form.team_leader_user_id === "none" ? null : form.team_leader_user_id,
        executive_user_id:
          form.executive_user_id === "none" ? null : form.executive_user_id,
        manager_user_id: form.manager_user_id === "none" ? null : form.manager_user_id,
        updated_at: new Date().toISOString(),
      };

      let teamId = editingTeam?.id;
      if (editingTeam) {
        const { error } = await supabase
          .from("teams")
          .update(payload)
          .eq("id", editingTeam.id);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("teams")
          .insert({ ...payload, created_at: new Date().toISOString() })
          .select("id")
          .single();
        if (error) throw error;
        teamId = data.id;
      }

      if (!teamId) throw new Error("Team id missing");

      await supabase.from("team_members").delete().eq("team_id", teamId);

      if (form.member_ids.length > 0) {
        const rows = form.member_ids.map((uid) => ({
          team_id: teamId,
          user_id: uid,
          organization_id: organizationId,
        }));
        const { error: memErr } = await supabase.from("team_members").insert(rows);
        if (memErr) throw memErr;
      }

      toast({ title: t("hierarchy.teamSaved") });
      setDialogOpen(false);
      await load();
    } catch (e: unknown) {
      toast({
        title: t("hierarchy.teamSaveFailed"),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const deleteTeam = async (team: TeamRow) => {
    if (!confirm(t("hierarchy.confirmDeleteTeam", { name: team.name }))) return;
    const { error } = await supabase.from("teams").delete().eq("id", team.id);
    if (error) {
      toast({ title: t("hierarchy.teamDeleteFailed"), variant: "destructive" });
      return;
    }
    toast({ title: t("hierarchy.teamDeleted") });
    await load();
  };

  const saveRoleLabels = async () => {
    if (!organizationId) return;
    setSavingLabels(true);
    const { error } = await supabase
      .from("organization_settings")
      .update({ approval_hierarchy_role_labels: roleLabelsDraft })
      .eq("organization_id", organizationId);
    setSavingLabels(false);
    if (error) {
      toast({ title: t("hierarchy.labelsSaveFailed"), variant: "destructive" });
      return;
    }
    invalidateOrgSettings(organizationId);
    toast({ title: t("hierarchy.labelsSaved") });
    await refreshLabels();
  };

  const usersByRole = (role: string) =>
    users.filter((u) => u.role === role);

  const employees = users.filter((u) => u.role === "employee");

  const leaderTeamCounts = useMemo(() => {
    const byUser = new Map<string, { manager: number; executive: number; team_leader: number }>();
    const bump = (userId: string | null, key: "manager" | "executive" | "team_leader") => {
      if (!userId) return;
      const cur = byUser.get(userId) ?? { manager: 0, executive: 0, team_leader: 0 };
      cur[key] += 1;
      byUser.set(userId, cur);
    };
    for (const team of teams) {
      bump(team.manager_user_id, "manager");
      bump(team.executive_user_id, "executive");
      bump(team.team_leader_user_id, "team_leader");
    }
    return byUser;
  }, [teams]);

  const sharedLeaderNote = (userId: string | null, role: "manager" | "executive" | "team_leader") => {
    if (!userId) return null;
    const count = leaderTeamCounts.get(userId)?.[role] ?? 0;
    if (count <= 1) return null;
    const name = users.find((u) => u.user_id === userId)?.name ?? "Leader";
    return `${name} leads ${count} teams`;
  };

  const toggleMember = (userId: string) => {
    setForm((f) => ({
      ...f,
      member_ids: f.member_ids.includes(userId)
        ? f.member_ids.filter((id) => id !== userId)
        : [...f.member_ids, userId],
    }));
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("hierarchy.title")}</CardTitle>
        </CardHeader>
        <CardContent>{t("common:loading")}</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            {t("hierarchy.roleLabelsTitle")}
          </CardTitle>
          <CardDescription>{t("hierarchy.roleLabelsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {(
            Object.keys(DEFAULT_ROLE_LABELS) as Array<keyof typeof DEFAULT_ROLE_LABELS>
          ).map((key) => (
            <div key={key} className="space-y-2">
              <Label>{key}</Label>
              <Input
                value={roleLabelsDraft[key] ?? ""}
                onChange={(e) =>
                  setRoleLabelsDraft((d) => ({ ...d, [key]: e.target.value }))
                }
              />
            </div>
          ))}
          <div className="sm:col-span-2">
            <Button onClick={() => void saveRoleLabels()} disabled={savingLabels}>
              <Save className="h-4 w-4 mr-2" />
              {t("hierarchy.saveRoleLabels")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{t("hierarchy.teamsTitle")}</CardTitle>
            <CardDescription>{t("hierarchy.teamsDescription")}</CardDescription>
          </div>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            {t("hierarchy.addTeam")}
          </Button>
        </CardHeader>
        <CardContent>
          {teams.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("hierarchy.noTeams")}</p>
          ) : (
            <ul className="space-y-3">
              {teams.map((team) => (
                <li
                  key={team.id}
                  className="flex items-center justify-between border rounded-lg p-3"
                >
                  <div>
                    <p className="font-medium">{team.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {t("hierarchy.teamMeta", {
                        mode: t(`hierarchy.routing.${team.routing_mode}`),
                        members: team.member_count ?? 0,
                        tl: team.team_leader_user_id
                          ? users.find((u) => u.user_id === team.team_leader_user_id)?.name
                          : "—",
                        mgr: team.manager_user_id
                          ? users.find((u) => u.user_id === team.manager_user_id)?.name
                          : "—",
                      })}
                    </p>
                    {(team.member_count ?? 0) === 0 && (
                      <p className="text-xs text-amber-700 mt-1">
                        No members — this team will not appear on My Teams until employees are assigned.
                      </p>
                    )}
                    {!team.manager_user_id && (
                      <p className="text-xs text-amber-700 mt-1">
                        No manager assigned — team leaders should still see the team if they are set as TL/Executive.
                      </p>
                    )}
                    {sharedLeaderNote(team.manager_user_id, "manager") && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {sharedLeaderNote(team.manager_user_id, "manager")}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => void openEdit(team)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void deleteTeam(team)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTeam ? t("hierarchy.editTeam") : t("hierarchy.addTeam")}
            </DialogTitle>
            <DialogDescription>{t("hierarchy.teamDialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("hierarchy.teamName")}</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("hierarchy.routingMode")}</Label>
              <Select
                value={form.routing_mode}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    routing_mode: v as (typeof ROUTING_MODES)[number],
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROUTING_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {t(`hierarchy.routing.${m}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{labelFor("team_leader")}</Label>
              <Select
                value={form.team_leader_user_id}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, team_leader_user_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("hierarchy.none")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("hierarchy.none")}</SelectItem>
                  {usersByRole("team_leader").map((u) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{labelFor("executive")}</Label>
              <Select
                value={form.executive_user_id}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, executive_user_id: v }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("hierarchy.none")}</SelectItem>
                  {usersByRole("executive").map((u) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{labelFor("engineer")}</Label>
              <Select
                value={form.manager_user_id}
                onValueChange={(v) => setForm((f) => ({ ...f, manager_user_id: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("hierarchy.none")}</SelectItem>
                  {usersByRole("engineer").map((u) => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("hierarchy.members")}</Label>
              <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1">
                {employees.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("hierarchy.noEmployees")}</p>
                ) : (
                  employees.map((emp) => (
                    <label
                      key={emp.user_id}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={form.member_ids.includes(emp.user_id)}
                        onChange={() => toggleMember(emp.user_id)}
                      />
                      {emp.name}
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={() => void saveTeam()} disabled={saving}>
              {saving ? t("common:saving") : t("common:save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
