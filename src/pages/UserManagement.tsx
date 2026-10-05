import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus, Mail, User, Shield, Settings, Sparkles, CheckCircle, AlertCircle, Edit, Trash2, Eye, EyeOff, Search, Lock, Copy, Check, Table2, Network, MapPin, Upload, FileText, Activity } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useToast } from "@/hooks/use-toast";
import { z } from "zod";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { formatINR } from "@/lib/format";
import { detectBulkUsersCsvMode, parseBulkUsersCsv } from "@/lib/bulkUsersCsv";
import { absoluteUrl } from "@/lib/siteConfig";
import { generateSyntheticUserEmail } from "@/lib/syntheticEmail";
import { RoleSelectItems } from "@/components/RoleSelectItems";
import { RoleBadgeWithLabels } from "@/components/RoleBadgeWithLabels";
import {
  allowedSupervisorRolesFor,
  immediateSupervisorFieldHint,
  immediateSupervisorFieldLabel,
  isImmediateSupervisorRequired,
  roleShowsImmediateSupervisor,
} from "@/lib/immediateSupervisor";
import { useRequireImmediateSupervisor } from "@/hooks/useRequireImmediateSupervisor";
import { getRoleLabel, userMatchesManagementSearch, type RoleLabels } from "@/lib/approvalHierarchy";
import { buildUserHierarchyView, hierarchyNodeMatchesSearch } from "@/lib/userHierarchyView";
import { UserHierarchySubordinates } from "@/components/UserHierarchySubordinates";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { invokeAdminEdgeFunction } from "@/lib/invokeAdminEdgeFunction";
import { runBulkUsersImportInChunks } from "@/lib/bulkUsersImportClient";
import { fetchUserManagementList, type UserManagementListRow } from "@/lib/orgUsers";
import { fetchProfilesByUserIds } from "@/lib/supabaseInQuery";
import { formatApiError } from "@/lib/formatApiError";
import { useOrgMembershipRoles } from "@/hooks/useOrgMembershipRoles";
import { useViewportMode } from "@/hooks/useViewportMode";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { ListPagination } from "@/components/ListPagination";
import { paginateItems, clampPage } from "@/lib/listPagination";

const ORG_ROLES = [
  "admin",
  "engineer",
  "employee",
  "cashier",
  "team_leader",
  "executive",
] as const;

type OrgRole = (typeof ORG_ROLES)[number];

const createUserBaseSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  role: z.enum(ORG_ROLES),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

interface CreateUserForm {
  name: string;
  email: string;
  employee_id: string;
  role: OrgRole;
  password: string;
  teamId?: string | "none";
  reportingEngineerId?: string | "none";
  cashierAssignedEngineerId?: string | "none";
  cashierAssignedLocationId?: string | "none";
  assignedCashierId?: string | "none";
  locationId?: string | "none";
}

export default function UserManagement() {
  const { t } = useTranslation(["admin", "common", "cashier"]);
  const navigate = useNavigate();
  const { userRole, user, organizationId, organizationFeatureFlags, organization, hasOrganizationFeature } =
    useAuth();
  const activityInsightsEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.user_activity_insights,
  );
  const hierarchyEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
  );
  const teamsEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.teams_enabled,
  );
  const teamLeaderTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader]);
  const executiveTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_executive]);
  const { requireImmediateSupervisor } = useRequireImmediateSupervisor();
  const { roleLabels } = useOrganizationRoleLabels();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: cachedRolesById } = useOrgMembershipRoles(organizationId);
  const { isMobile } = useViewportMode();
  const { policy: identityPolicy, getSearchPlaceholderKey } = useOrganizationIdentityMode();
  const teamLeaderLabel = getRoleLabel("team_leader", roleLabels);
  const executiveLabel = getRoleLabel("executive", roleLabels);

  const assertSupervisorIfRequired = (role: OrgRole, reportingEngineerId?: string) => {
    if (!isImmediateSupervisorRequired(role, requireImmediateSupervisor)) return;
    if (!reportingEngineerId || reportingEngineerId === "none") {
      throw new Error(
        "Immediate supervisor is required. Enable a supervisor in User Management or turn off “Require immediate supervisor” in Settings.",
      );
    }
  };

  const showEmployeeIdField = Boolean(
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.employee_id_login],
  );
  const useEmailAuto = Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.user_email_auto]);
  
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [engineers, setEngineers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [cashiers, setCashiers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [users, setUsers] = useState<UserManagementListRow[]>([]);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [engineerLocations, setEngineerLocations] = useState<Record<string, string>>({}); // engineer_id -> location_id (single location only)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ user_id: string; name: string; email: string; balance: number; role: string } | null>(null);
  const [expensesLoading, setExpensesLoading] = useState(false);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [logsByExpense, setLogsByExpense] = useState<Record<string, any[]>>({});
  const [deductions, setDeductions] = useState<any[]>([]);
  const [formData, setFormData] = useState<CreateUserForm>({
    name: "",
    email: "",
    employee_id: "",
    role: "employee",
    password: "",
    reportingEngineerId: "none",
    teamId: "none",
    cashierAssignedEngineerId: "none",
    cashierAssignedLocationId: "none",
    locationId: "none",
  });
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [userToEdit, setUserToEdit] = useState<{ user_id: string; name: string; email: string; balance: number; role: string } | null>(null);
  const [userToDelete, setUserToDelete] = useState<{ user_id: string; name: string; email: string } | null>(null);
  const [editFormData, setEditFormData] = useState<{ name: string; email: string; employee_id: string; role: OrgRole; reportingEngineerId: string; teamId: string; cashierAssignedEngineerId: string; cashierAssignedLocationId: string; assignedCashierId: string; locationId: string; balance: number; isAccountantCashier: boolean }>({
    name: "",
    email: "",
    employee_id: "",
    role: "employee",
    reportingEngineerId: "none",
    teamId: "none",
    cashierAssignedEngineerId: "none",
    cashierAssignedLocationId: "none",
    assignedCashierId: "none",
    locationId: "none",
    balance: 0,
    isAccountantCashier: false,
  });
  const cashierAccountantModeEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.cashier_accountant_mode,
  );
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deactivationImpact, setDeactivationImpact] = useState<{
    reports_count: number; pending_reviews_assigned: number; pending_expense_assignments: number; is_only_active_admin: boolean;
  } | null>(null);
  const [deactivationImpactLoading, setDeactivationImpactLoading] = useState(false);

  const getSupervisorOptions = useCallback(
    (subordinateRole: OrgRole, excludeUserId?: string) => {
      if (!roleShowsImmediateSupervisor(subordinateRole)) return [];
      const allowed = allowedSupervisorRolesFor(subordinateRole, {
        teamLeaderTierEnabled,
        executiveTierEnabled,
      });
      return users
        .filter((u) => allowed.includes(u.role) && u.user_id !== excludeUserId)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    },
    [users, teamLeaderTierEnabled, executiveTierEnabled],
  );

  const createSupervisorOptions = useMemo(
    () => getSupervisorOptions(formData.role),
    [getSupervisorOptions, formData.role],
  );

  const editSupervisorOptions = useMemo(
    () => getSupervisorOptions(editFormData.role, userToEdit?.user_id),
    [getSupervisorOptions, editFormData.role, userToEdit?.user_id],
  );
  const [showPassword, setShowPassword] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [resetPasswordConfirmOpen, setResetPasswordConfirmOpen] = useState(false);
  const [resetPasswordSuccessOpen, setResetPasswordSuccessOpen] = useState(false);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [passwordCopied, setPasswordCopied] = useState(false);
  const [viewMode, setViewMode] = useState<"table" | "hierarchical">("table");
  const [activeSection, setActiveSection] = useState<"list" | "create" | "bulk">(() => {
    const s = sessionStorage.getItem("userMgmt.section");
    return s === "create" || s === "bulk" ? s : "list";
  });
  const [usersPage, setUsersPage] = useState(() => {
    const p = Number(sessionStorage.getItem("userMgmt.page"));
    return p > 0 ? p : 1;
  });
  const [usersPageSize, setUsersPageSize] = useState(() => {
    const s = Number(sessionStorage.getItem("userMgmt.pageSize"));
    return [10, 25, 50, 100].includes(s) ? s : 25;
  });
  const [bulkUsersFile, setBulkUsersFile] = useState<File | null>(null);
  const [bulkUsersDryRun, setBulkUsersDryRun] = useState(true);
  const [bulkUsersLoading, setBulkUsersLoading] = useState(false);
  const [bulkUsersProgress, setBulkUsersProgress] = useState<string | null>(null);
  const [bulkUsersResult, setBulkUsersResult] = useState<any | null>(null);
  const {
    progress: listProgress,
    startOperation: startListProgress,
    completeOperation: completeListProgress,
  } = useOperationProgress();
  const {
    progress: bulkImportProgress,
    startOperation: startBulkImportProgress,
    updateOperation: updateBulkImportProgress,
    completeOperation: completeBulkImportProgress,
    failOperation: failBulkImportProgress,
    resetOperation: resetBulkImportProgress,
  } = useOperationProgress();
  const prevListLoadingRef = useRef(false);
  const [orgSeatSummary, setOrgSeatSummary] = useState<{
    maxUsers: number | null;
    activeMembers: number;
  } | null>(null);
  const [orgSeatSummaryLoading, setOrgSeatSummaryLoading] = useState(false);
  const [userStatusFilter, setUserStatusFilter] = useState<"all" | "active" | "deactivated">("active");

  const filteredUsers = useMemo(
    () =>
      users.filter(u => {
        if (userStatusFilter === "active" && !u.is_active) return false;
        if (userStatusFilter === "deactivated" && u.is_active) return false;
        if (teamFilter !== "all") {
          if (teamFilter === "none") { if (u.team_id) return false; }
          else if (u.team_id !== teamFilter) return false;
        }
        if (!searchTerm) return true;
        return userMatchesManagementSearch(u, searchTerm, roleLabels, identityPolicy);
      }),
    [users, searchTerm, teamFilter, roleLabels, identityPolicy, userStatusFilter],
  );

  const clampedUsersPage = useMemo(
    () => clampPage(usersPage, filteredUsers.length, usersPageSize),
    [usersPage, filteredUsers.length, usersPageSize],
  );

  const pagedUsers = useMemo(
    () => paginateItems(filteredUsers, clampedUsersPage, usersPageSize),
    [filteredUsers, clampedUsersPage, usersPageSize],
  );

  const refreshOrgSeatSummary = useCallback(async () => {
    if (!organizationId || userRole !== "admin") {
      setOrgSeatSummary(null);
      return;
    }
    setOrgSeatSummaryLoading(true);
    try {
      const [{ data: orgRow, error: orgErr }, { count, error: cntErr }] = await Promise.all([
        supabase.from("organizations").select("max_users").eq("id", organizationId).maybeSingle(),
        supabase
          .from("organization_memberships")
          .select("user_id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("is_active", true),
      ]);
      if (orgErr || cntErr) {
        console.error("refreshOrgSeatSummary:", orgErr || cntErr);
        setOrgSeatSummary(null);
        return;
      }
      const rawMax = orgRow?.max_users;
      setOrgSeatSummary({
        maxUsers: rawMax === null || rawMax === undefined ? null : Number(rawMax),
        activeMembers: count ?? 0,
      });
    } finally {
      setOrgSeatSummaryLoading(false);
    }
  }, [organizationId, userRole]);

  useEffect(() => {
    refreshOrgSeatSummary();
  }, [refreshOrgSeatSummary]);

  useEffect(() => {
    const wasLoading = prevListLoadingRef.current;
    prevListLoadingRef.current = listLoading;
    if (listLoading && !wasLoading) {
      startListProgress(t("admin:users.loadingUsers", { defaultValue: "Loading users…" }));
    } else if (!listLoading && wasLoading) {
      completeListProgress(t("admin:users.usersLoaded", { defaultValue: "Users loaded", count: users.length }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listLoading]);

  // Reset to page 1 when search or filter changes
  useEffect(() => { setUsersPage(1); }, [searchTerm, teamFilter]);

  // Persist pagination + section choices
  useEffect(() => { sessionStorage.setItem("userMgmt.page", String(usersPage)); }, [usersPage]);
  useEffect(() => { sessionStorage.setItem("userMgmt.pageSize", String(usersPageSize)); }, [usersPageSize]);
  useEffect(() => { sessionStorage.setItem("userMgmt.section", activeSection); }, [activeSection]);

  useEffect(() => {
    // Load engineers for assignment dropdown
    const loadEngineers = async () => {
      try {
        // 1) Get user ids with engineer role in this organization
        if (!organizationId) return;
        const { data: roleRows, error: rolesError } = await supabase
          .from("organization_memberships")
          .select("user_id, role")
          .eq("organization_id", organizationId)
          .eq("role", "engineer")
          .eq("is_active", true);

        if (rolesError) throw rolesError;

        const engineerIds = (roleRows || []).map(r => r.user_id);
        if (engineerIds.length === 0) {
          setEngineers([]);
          return;
        }

        const profileRows = (await fetchProfilesByUserIds(
          supabase,
          organizationId,
          engineerIds,
          "user_id, name, email",
        )) as { user_id: string; name: string; email: string }[];

        const list = profileRows.map(p => ({ id: p.user_id, name: p.name, email: p.email }));
        setEngineers(list);
      } catch (e) {
        console.error("Error loading engineers:", e);
      }
    };

    loadEngineers();
    
    // Load locations (filtered by organization)
    const loadLocations = async () => {
      try {
        if (!organizationId) return;
        const { data, error } = await supabase
          .from("locations")
          .select("id, name")
          .eq("organization_id", organizationId)
          .order("name", { ascending: true });
        if (error) throw error;
        setLocations(data || []);
      } catch (e) {
        console.error("Error loading locations:", e);
      }
    };
    loadLocations();

    const loadTeams = async () => {
      try {
        if (!organizationId || !teamsEnabled) {
          setTeams([]);
          return;
        }
        const { data, error } = await supabase
          .from("teams")
          .select("id, name")
          .eq("organization_id", organizationId)
          .order("name");
        if (error) throw error;
        setTeams(data ?? []);
      } catch (e) {
        console.error("Error loading teams:", e);
      }
    };
    loadTeams();
    
    // Load engineer-location assignments
    const loadEngineerLocations = async () => {
      try {
        const { data, error } = await supabase
          .from("engineer_locations")
          .select("engineer_id, location_id");
        if (error) throw error;
        
        const assignments: Record<string, string> = {};
        (data || []).forEach((el: any) => {
          // Only store the first location for each engineer (one location per engineer)
          if (!assignments[el.engineer_id]) {
            assignments[el.engineer_id] = el.location_id;
          }
        });
        setEngineerLocations(assignments);
      } catch (e) {
        console.error("Error loading engineer locations:", e);
      }
    };
    loadEngineerLocations();
    
    // Load users for admin list
    const loadUsers = async () => {
      try {
        if (!organizationId) {
          setListLoading(false);
          return;
        }
        setListLoading(true);
        const combined = await fetchUserManagementList(organizationId, cachedRolesById);
        setUsers(combined);
      } catch (e) {
        console.error("Error loading users list:", e);
        toast({
          variant: "destructive",
          title: t("admin:users.toast.loadFailed", { defaultValue: "Could not load users" }),
          description: formatApiError(e, "Failed to load user list."),
        });
      } finally {
        setListLoading(false);
      }
    };
    loadUsers();
  }, [organizationId, teamsEnabled]);

  const buildHierarchy = () =>
    buildUserHierarchyView(users, locations, engineerLocations, {
      teamLeaderTierEnabled,
      executiveTierEnabled,
    });

  const formatManagerTeamStats = (item: ReturnType<typeof buildHierarchy>["unassignedEngineers"][0]) => {
    const parts: string[] = [];
    if (item.engineer.cashierCount > 0) {
      parts.push(`${item.engineer.cashierCount} Cashier${item.engineer.cashierCount !== 1 ? "s" : ""}`);
    }
    if (executiveTierEnabled && item.engineer.executiveCount > 0) {
      parts.push(
        `${item.engineer.executiveCount} ${executiveLabel}${item.engineer.executiveCount !== 1 ? "s" : ""}`,
      );
    }
    if (teamLeaderTierEnabled && item.engineer.teamLeaderCount > 0) {
      parts.push(
        `${item.engineer.teamLeaderCount} ${teamLeaderLabel}${item.engineer.teamLeaderCount !== 1 ? "s" : ""}`,
      );
    }
    parts.push(
      `${item.engineer.employeeCount} Employee${item.engineer.employeeCount !== 1 ? "s" : ""}`,
    );
    return parts.join(" • ");
  };

  const openUserDrawer = async (u: { user_id: string; name: string; email: string; balance: number; role: string }) => {
    setSelectedUser(u);
    setDrawerOpen(true);
    setExpensesLoading(true);
    try {
      const { data, error } = await supabase
        .from("expenses")
        .select("id, title, total_amount, status, created_at, updated_at")
        .eq("user_id", u.user_id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const list = data || [];
      setExpenses(list);

      // Fetch audit logs for these expenses to build history and deductions
      const expenseIds = list.map((e: any) => e.id);
      if (expenseIds.length > 0) {
        const { data: logs, error: logsErr } = await supabase
          .from("audit_logs")
          .select("expense_id, user_id, action, comment, created_at")
          .in("expense_id", expenseIds)
          .order("created_at", { ascending: false });
        if (logsErr) throw logsErr;

        const grouped: Record<string, any[]> = {};
        (logs || []).forEach((log: any) => {
          if (!grouped[log.expense_id]) grouped[log.expense_id] = [];
          grouped[log.expense_id].push(log);
        });
        setLogsByExpense(grouped);

        // Deductions are the admin approvals for this user's expenses
        const approvals = (logs || []).filter(l => l.action === "expense_approved");
        // Map to include the expense info and amount (use total_amount)
        const deduced = approvals.map((l: any) => {
          const exp = list.find((e: any) => e.id === l.expense_id);
          return {
            expense_id: l.expense_id,
            title: exp?.title || "Untitled",
            amount: Number(exp?.total_amount ?? 0),
            at: l.created_at,
            comment: l.comment || "",
          };
        });
        setDeductions(deduced);
      } else {
        setLogsByExpense({});
        setDeductions([]);
      }
    } catch (e) {
      console.error("Failed to load expenses for user:", e);
    } finally {
      setExpensesLoading(false);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (userRole !== "admin") {
      toast({
        variant: "destructive",
        title: t("admin:users.toast.accessDenied"),
        description: "Only administrators can create user accounts",
      });
      return;
    }

    // Check if password is empty or too short
    if (!formData.password || formData.password.length < 8) {
      toast({
        variant: "destructive",
        title: "Password Required",
        description: "Please enter a password with at least 8 characters or use the Generate button",
      });
      return;
    }

    try {
      const baseParsed = createUserBaseSchema.parse(formData);

      let emailForCreate = String(formData.email || "").trim().toLowerCase();
      if (useEmailAuto) {
        if (!organizationId) throw new Error("Organization not found.");
        const empPart = showEmployeeIdField
          ? String(formData.employee_id || "").trim()
          : `acct`;
        if (showEmployeeIdField && !empPart) {
          throw new Error("Employee ID is required when employee ID is enabled for this organization.");
        }
        emailForCreate = generateSyntheticUserEmail({
          organizationId,
          employeeIdPart: empPart || "user",
          orgSubdomain: organization?.subdomain ?? null,
        });
      } else {
        const em = z.string().email("Invalid email address").safeParse(emailForCreate);
        if (!em.success) {
          throw new Error(em.error.errors[0]?.message || "Invalid email");
        }
        emailForCreate = em.data;
      }

      if (showEmployeeIdField) {
        const eid = String(formData.employee_id || "").trim().toLowerCase();
        if (!eid) {
          throw new Error("Employee ID is required for this organization.");
        }
      }

      const validated = {
        name: baseParsed.name,
        email: emailForCreate,
        role: baseParsed.role,
        password: baseParsed.password,
      };

      assertSupervisorIfRequired(validated.role, formData.reportingEngineerId);

      setLoading(true);

      if (!organizationId) {
        throw new Error("Organization not found. Please contact support.");
      }

      const createResult = await invokeAdminEdgeFunction<{
        success?: boolean;
        error?: string;
        user?: { id: string; email?: string };
      }>("admin-create-user", {
        organization_id: organizationId,
        email: validated.email,
        password: validated.password,
        name: validated.name,
        role: validated.role,
        employee_id: showEmployeeIdField
          ? String(formData.employee_id || "").trim().toLowerCase() || undefined
          : undefined,
      });

      if (!createResult?.success || !createResult?.user?.id) {
        const message =
          typeof createResult?.error === "string"
            ? createResult.error
            : "Failed to create user account";
        if (message.includes("already registered") || message.includes("already exists")) {
          throw new Error("An account with this email already exists");
        }
        throw new Error(message);
      }

      const authData = {
        user: {
          id: createResult.user.id as string,
          email: (createResult.user.email as string) || validated.email,
        },
      };

      // Track whether any optional setup step failed — used for the toast description.
      let setupWarning = false;

      if (
        validated.role === "employee" &&
        teamsEnabled &&
        formData.teamId &&
        formData.teamId !== "none" &&
        organizationId
      ) {
        try {
          await supabase.from("team_members").delete().eq("user_id", authData.user.id);
          const { error: teamMemErr } = await supabase.from("team_members").insert({
            team_id: formData.teamId,
            user_id: authData.user.id,
            organization_id: organizationId,
          });
          if (teamMemErr) {
            console.error("team_members insert:", teamMemErr);
            setupWarning = true;
          }
        } catch (err) {
          console.error("team_members insert threw:", err);
          setupWarning = true;
        }
      }

      if (
        roleShowsImmediateSupervisor(validated.role) &&
        formData.reportingEngineerId &&
        formData.reportingEngineerId !== "none"
      ) {
        const updateData: { reporting_engineer_id: string; assigned_cashier_id?: string } = {
          reporting_engineer_id: formData.reportingEngineerId,
        };

        if (
          validated.role === "employee" &&
          formData.assignedCashierId &&
          formData.assignedCashierId !== "none"
        ) {
          updateData.assigned_cashier_id = formData.assignedCashierId;
        }

        try {
          const { error: profileUpdateError } = await supabase
            .from("profiles")
            .update(updateData)
            .eq("user_id", authData.user.id);
          if (profileUpdateError) {
            console.error("Profile update (supervisor/cashier):", profileUpdateError);
            setupWarning = true;
          }
        } catch (err) {
          console.error("Profile update (supervisor/cashier) threw:", err);
          setupWarning = true;
        }
      } else if (
        validated.role === "employee" &&
        formData.assignedCashierId &&
        formData.assignedCashierId !== "none"
      ) {
        try {
          const { error: profileUpdateError } = await supabase
            .from("profiles")
            .update({ assigned_cashier_id: formData.assignedCashierId })
            .eq("user_id", authData.user.id);
          if (profileUpdateError) {
            console.error("Profile update (cashier):", profileUpdateError);
            setupWarning = true;
          }
        } catch (err) {
          console.error("Profile update (cashier) threw:", err);
          setupWarning = true;
        }
      }

      // If creating an engineer and a cashier is chosen, link them
      if (validated.role === "engineer" && formData.assignedCashierId && formData.assignedCashierId !== "none") {
        try {
          const { error: profileUpdateError } = await supabase
            .from("profiles")
            .update({ assigned_cashier_id: formData.assignedCashierId })
            .eq("user_id", authData.user.id);
          if (profileUpdateError) {
            console.error("Profile update (engineer cashier link):", profileUpdateError);
            setupWarning = true;
          }
        } catch (err) {
          console.error("Profile update (engineer cashier link) threw:", err);
          setupWarning = true;
        }
      }

      // If creating a cashier, handle location or engineer assignment
      if (validated.role === "cashier") {
        try {
          const updateData: any = {};

          // Priority: Location assignment over direct engineer assignment
          if (formData.cashierAssignedLocationId && formData.cashierAssignedLocationId !== "none") {
            const { data: profilesWithLocation, error: profilesError } = await supabase
              .from("profiles")
              .select("user_id")
              .eq("cashier_assigned_location_id", formData.cashierAssignedLocationId);

            if (profilesError) {
              console.error("Cashier location check:", profilesError);
              setupWarning = true;
            } else {
              if (profilesWithLocation && profilesWithLocation.length > 0) {
                const userIds = profilesWithLocation.map(p => p.user_id);
                const { data: cashierRoles, error: rolesError } = await supabase
                  .from("organization_memberships")
                  .eq("organization_id", organizationId!)
                  .eq("is_active", true)
                  .select("user_id")
                  .in("user_id", userIds)
                  .eq("role", "cashier");

                if (rolesError) {
                  console.error("Cashier roles check:", rolesError);
                  setupWarning = true;
                } else if (cashierRoles && cashierRoles.length > 0) {
                  // Conflict — location already has a cashier; skip assignment but don't abort
                  console.warn("Location already has a cashier; skipping location assignment.");
                  setupWarning = true;
                } else {
                  updateData.cashier_assigned_location_id = formData.cashierAssignedLocationId;
                  updateData.cashier_assigned_engineer_id = null;
                }
              } else {
                updateData.cashier_assigned_location_id = formData.cashierAssignedLocationId;
                updateData.cashier_assigned_engineer_id = null;
              }
            }
          } else if (formData.cashierAssignedEngineerId && formData.cashierAssignedEngineerId !== "none") {
            const { data: existingCashier, error: checkError } = await supabase
              .from("profiles")
              .select("user_id")
              .eq("cashier_assigned_engineer_id", formData.cashierAssignedEngineerId)
              .limit(1);

            if (checkError) {
              console.error("Engineer cashier check:", checkError);
              setupWarning = true;
            } else if (existingCashier && existingCashier.length > 0) {
              console.warn("Engineer already has a cashier; skipping assignment.");
              setupWarning = true;
            } else {
              updateData.cashier_assigned_engineer_id = formData.cashierAssignedEngineerId;
              updateData.cashier_assigned_location_id = null;
            }
          }

          if (Object.keys(updateData).length > 0) {
            const { error: profileUpdateError } = await supabase
              .from("profiles")
              .update(updateData)
              .eq("user_id", authData.user.id);

            if (profileUpdateError) {
              console.error("Cashier profile update:", profileUpdateError);
              setupWarning = true;
            } else if (updateData.cashier_assigned_location_id) {
              const { error: syncError } = await supabase.rpc('sync_engineers_with_location_cashier', {
                location_id_param: updateData.cashier_assigned_location_id
              });
              if (syncError) {
                console.error("Error syncing engineers with location cashier:", syncError);
              }
            }
          }
        } catch (err) {
          console.error("Cashier assignment threw:", err);
          setupWarning = true;
        }
      }

      // If creating an engineer and a location is selected, assign it
      if (validated.role === "engineer" && formData.locationId && formData.locationId !== "none") {
        try {
          const { error: locationError } = await supabase
            .from("engineer_locations")
            .insert({
              engineer_id: authData.user.id,
              location_id: formData.locationId,
              organization_id: organizationId,
            });
          if (locationError) {
            console.error("Engineer location assignment:", locationError);
            setupWarning = true;
          }
        } catch (err) {
          console.error("Engineer location assignment threw:", err);
          setupWarning = true;
        }
      }

      try {
        await supabase.functions.invoke("send-account-created-email", {
          body: {
            name: validated.name,
            email: validated.email,
            password: validated.password,
            sign_in_url: absoluteUrl("/auth"),
          },
        });
      } catch (emailError) {
        console.error("Failed to send account-created email:", emailError);
      }

      // Success toast — always fires once the user record exists, regardless of optional setup steps.
      toast({
        title: t("admin:users.toast.userCreated"),
        description: setupWarning
          ? t("admin:users.toast.setupWarning")
          : t("admin:users.toast.userCreatedDescription", {
              name: validated.name,
              role: validated.role,
            }),
      });

      if (organizationId) {
        void queryClient.invalidateQueries({ queryKey: ["org-membership-roles", organizationId] });
      }

      // Reset form
      setFormData({
        name: "",
        email: "",
        role: "employee",
        password: "",
        reportingEngineerId: "none",
        cashierAssignedEngineerId: "none",
        cashierAssignedLocationId: "none",
        locationId: "none",
      });
      setShowPassword(false);
      
      // Reload engineer locations
      const { data: elData, error: elError } = await supabase
        .from("engineer_locations")
        .select("engineer_id, location_id");
      if (!elError && elData) {
        const assignments: Record<string, string> = {};
        elData.forEach((el: any) => {
          // Only store the first location for each engineer (one location per engineer)
          if (!assignments[el.engineer_id]) {
            assignments[el.engineer_id] = el.location_id;
          }
        });
        setEngineerLocations(assignments);
      }

    } catch (error: any) {
      console.error("Error creating user:", error);
      
      if (error instanceof z.ZodError) {
        toast({
          variant: "destructive",
          title: "Validation Error",
          description: error.errors[0].message,
        });
      } else if (error.message?.includes("already registered")) {
        toast({
          variant: "destructive",
          title: "User Already Exists",
          description: "An account with this email already exists",
        });
      } else {
        toast({
          variant: "destructive",
          title: "Error Creating User",
          description: error.message || "Failed to create user account",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const generatePassword = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
    let password = "";
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormData(prev => ({ ...prev, password }));
    setShowPassword(true); // Automatically show the generated password
  };

  const downloadBulkUsersTemplate = () => {
    const csv = showEmployeeIdField
      ? [
          "name,employee_id,position,password,immediate_supervisor_email,immediate_supervisor_employee_id,location,team_name",
          "John Manager,3721,manager,Password@123,,,Mumbai,",
          "Alice Employee,5002,employee,Password@123,john.manager@microlink.com,,Mumbai,Reliance C&I",
          "Bob Cashier,CSH001,cashier,Password@123,john.manager@microlink.com,3721,Mumbai,",
        ].join("\n")
      : [
          "name,email,position,password,immediate_supervisor_email,location,team_name",
          "John Manager,john.manager@company.com,manager,Password@123,,Mumbai,",
          "Alice Employee,alice.employee@company.com,employee,Password@123,john.manager@company.com,Mumbai,Reliance C&I",
          "Bob Cashier,bob.cashier@company.com,cashier,Password@123,john.manager@company.com,Mumbai,",
        ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk-users-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleBulkUsersUpload = async () => {
    if (!bulkUsersFile) {
      toast({ variant: "destructive", title: "CSV required", description: "Please choose a CSV file." });
      return;
    }
    if (!organizationId) {
      toast({ variant: "destructive", title: "Organization missing", description: "Please re-login and try again." });
      return;
    }
    try {
      setBulkUsersLoading(true);
      setBulkUsersProgress(null);
      resetBulkImportProgress();
      startBulkImportProgress(t("admin:users.bulkImporting", { defaultValue: "Importing users…" }));
      const text = await bulkUsersFile.text();
      const csvMode = detectBulkUsersCsvMode(text);
      if (csvMode === "employee_id" && !showEmployeeIdField) {
        toast({
          variant: "destructive",
          title: "Employee ID login is not enabled",
          description:
            "Your CSV uses employee_id (no email column). Enable “Employee ID login” in Master Admin → Organization Features for this org, then upload again. Or use the email CSV template from Download Template.",
        });
        setBulkUsersResult({
          success: false,
          errors: [
            "CSV uses employee_id format but Employee ID login is disabled for this organization.",
          ],
        });
        return;
      }
      const parsed = parseBulkUsersCsv(text, {
        employeeIdLoginMode: showEmployeeIdField || csvMode === "employee_id",
      });
      if (parsed.errors.length > 0) {
        toast({
          variant: "destructive",
          title: "CSV validation failed",
          description: parsed.errors.slice(0, 2).join(" | "),
        });
        setBulkUsersResult({ success: false, errors: parsed.errors });
        return;
      }

      const data = await runBulkUsersImportInChunks({
        organizationId,
        dryRun: bulkUsersDryRun,
        rows: parsed.rows,
        invoke: (body) => invokeAdminEdgeFunction<Record<string, unknown>>("bulk-users-import", body),
        onProgress: ({ completed, total, chunk, chunks }) => {
          const label = chunks > 1 ? `Processing ${completed} / ${total} (batch ${chunk} of ${chunks})…` : null;
          setBulkUsersProgress(label);
          updateBulkImportProgress(
            t("admin:users.bulkImporting", { defaultValue: "Importing users…" }),
            { completed, total },
          );
        },
      });

      setBulkUsersResult(data || null);
      completeBulkImportProgress(t("admin:users.bulkComplete", { defaultValue: "Import complete" }));
      void refreshOrgSeatSummary();
      const supervisorWarnings =
        (data?.results || []).filter((r) =>
          Array.isArray(r.warnings) && r.warnings.some((w) => String(w).includes("supervisor")),
        ).length ?? 0;
      const linkWarnings = data?.supervisor_link?.warnings?.length ?? 0;
      const linkLinked = data?.supervisor_link?.linked;
      const passwordUpdated = data?.password_sync?.updated;
      toast({
        title: bulkUsersDryRun ? "Dry-run complete" : "Bulk upload complete",
        description:
          `Processed ${data?.total ?? 0}: ${data?.ok ?? 0} success, ${data?.failed ?? 0} failed` +
          (data?.chunks && data.chunks > 1 ? ` (${data.chunks} batches)` : "") +
          (linkLinked != null
            ? `. Supervisor links: ${linkLinked} would apply${bulkUsersDryRun ? "" : "d"}, ${data?.supervisor_link?.skipped ?? 0} skipped.`
            : "") +
          (passwordUpdated != null
            ? `. Passwords: ${passwordUpdated} ${bulkUsersDryRun ? "would update" : "updated"}.`
            : "") +
          (supervisorWarnings > 0 || linkWarnings > 0
            ? ` ${supervisorWarnings + linkWarnings} supervisor warning(s) — expand result JSON.`
            : ""),
      });
    } catch (e: any) {
      failBulkImportProgress(t("admin:users.bulkComplete", { defaultValue: "Import complete" }), e?.message || "Unable to import CSV");
      toast({
        variant: "destructive",
        title: "Bulk upload failed",
        description: e?.message || "Unable to import CSV",
      });
    } finally {
      setBulkUsersLoading(false);
      setBulkUsersProgress(null);
    }
  };

  const openEditDialog = (u: { user_id: string; name: string; email: string; balance: number; role: string }) => {
    setUserToEdit(u);
    // Fetch assignments (engineer for employee, engineer for cashier, locations for engineer)
    const fetchAssignments = async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("reporting_engineer_id, cashier_assigned_engineer_id, cashier_assigned_location_id, assigned_cashier_id, employee_id")
          .eq("user_id", u.user_id)
          .single();
        
        // Fetch location for engineer (only one location allowed)
        let locationId: string = "none";
        if (u.role === "engineer") {
          const { data: locationData } = await supabase
            .from("engineer_locations")
            .select("location_id")
            .eq("engineer_id", u.user_id)
            .limit(1)
            .maybeSingle();
          locationId = locationData?.location_id || "none";
        }
        
        let isAccountantCashier = false;
        if (organizationId && u.role === "cashier") {
          const { data: membership } = await supabase
            .from("organization_memberships")
            .select("is_accountant_cashier")
            .eq("organization_id", organizationId)
            .eq("user_id", u.user_id)
            .maybeSingle();
          isAccountantCashier = membership?.is_accountant_cashier === true;
        }

        let teamId = "none";
        if (teamsEnabled && u.role === "employee" && organizationId) {
          const { data: teamMem } = await supabase
            .from("team_members")
            .select("team_id")
            .eq("organization_id", organizationId)
            .eq("user_id", u.user_id)
            .maybeSingle();
          teamId = teamMem?.team_id || "none";
        }

        setEditFormData({
          name: u.name,
          email: u.email,
          employee_id: String((data as any)?.employee_id || ""),
          role: u.role as OrgRole,
          reportingEngineerId: (data as any)?.reporting_engineer_id || "none",
          teamId,
          cashierAssignedEngineerId: (data as any)?.cashier_assigned_engineer_id || "none",
          cashierAssignedLocationId: (data as any)?.cashier_assigned_location_id || "none",
          assignedCashierId: (data as any)?.assigned_cashier_id || "none",
          locationId: locationId,
          balance: Number(u.balance ?? 0),
          isAccountantCashier,
        });
      } catch (e) {
        setEditFormData({
          name: u.name,
          email: u.email,
          employee_id: "",
          role: u.role as OrgRole,
          reportingEngineerId: "none",
          teamId: "none",
          cashierAssignedEngineerId: "none",
          cashierAssignedLocationId: "none",
          assignedCashierId: "none",
          locationId: "none",
          balance: Number(u.balance ?? 0),
          isAccountantCashier: false,
        });
      }
    };
    fetchAssignments();
    setEditDialogOpen(true);
  };

  const openDeleteDialog = (u: { user_id: string; name: string; email: string }) => {
    setUserToDelete(u);
    setDeactivationImpact(null);
    setDeleteDialogOpen(true);
    if (organizationId) {
      setDeactivationImpactLoading(true);
      // src/integrations/supabase/types.ts predates this RPC (same
      // narrow, commented escape src/lib/backupExportJobs.ts already
      // uses for the same reason).
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error } = await (supabase as any).rpc("get_user_deactivation_impact_v1", {
            p_organization_id: organizationId,
            p_user_id: u.user_id,
          });
          if (!error && data) setDeactivationImpact(data as typeof deactivationImpact);
        } finally {
          setDeactivationImpactLoading(false);
        }
      })();
    }
  };

  const handleUpdateUser = async () => {
    if (!userToEdit) return;

    try {
      assertSupervisorIfRequired(editFormData.role, editFormData.reportingEngineerId);
      setUpdating(true);
      const normalizedEmail = String(editFormData.email || "").trim().toLowerCase();
      const previousEmail = String(userToEdit.email || "").trim().toLowerCase();
      const emailChanged = normalizedEmail !== previousEmail;

      if (!normalizedEmail) {
        throw new Error("Email is required");
      }

      if (emailChanged) {
        let emailUpdateResult: { success?: boolean; error?: string };
        try {
          emailUpdateResult = await invokeAdminEdgeFunction("admin-update-user-email", {
            target_user_id: userToEdit.user_id,
            new_email: normalizedEmail,
          });
        } catch (emailUpdateError) {
          const msg =
            emailUpdateError instanceof Error
              ? emailUpdateError.message
              : "Failed to update authentication email";
          if (msg.toLowerCase().includes("already")) {
            throw new Error("An account with this email already exists");
          }
          throw new Error(msg);
        }

        if (!emailUpdateResult?.success) {
          const msg = String(emailUpdateResult?.error || "Failed to update authentication email");
          if (msg.toLowerCase().includes("already")) {
            throw new Error("An account with this email already exists");
          }
          if (msg.toLowerCase().includes("invalid email")) {
            throw new Error("Please enter a valid email address");
          }
          throw new Error(msg);
        }
      }

      // Update profile (name, email, assignments, balance for admin)
      // Clear assignments when role changes - only set if role matches
      const updateData: any = {
        name: editFormData.name,
        email: normalizedEmail,
      };
      if (showEmployeeIdField) {
        const eid = String(editFormData.employee_id || "").trim().toLowerCase();
        updateData.employee_id = eid || null;
      }
      if (userRole === "admin" && typeof editFormData.balance === "number" && !Number.isNaN(editFormData.balance)) {
        updateData.balance = editFormData.balance;
      }

      if (roleShowsImmediateSupervisor(editFormData.role)) {
        updateData.reporting_engineer_id =
          editFormData.reportingEngineerId !== "none"
            ? editFormData.reportingEngineerId
            : null;
        if (editFormData.role === "employee") {
          updateData.assigned_cashier_id =
            editFormData.assignedCashierId !== "none"
              ? editFormData.assignedCashierId
              : null;
        } else {
          updateData.assigned_cashier_id = null;
        }
      } else if (editFormData.role === "engineer") {
        updateData.assigned_cashier_id =
          editFormData.assignedCashierId !== "none"
            ? editFormData.assignedCashierId
            : null;
        updateData.reporting_engineer_id = null;
      } else {
        updateData.reporting_engineer_id = null;
        updateData.assigned_cashier_id = null;
      }
      
      // Handle cashier assignment (for cashiers) - location takes priority
      if (editFormData.role === "cashier") {
        // Priority: Location assignment over direct engineer assignment
        if (editFormData.cashierAssignedLocationId && editFormData.cashierAssignedLocationId !== "none") {
          // Check if location already has a cashier (unless it's the current cashier being edited)
          // First get all profiles with this location assigned (excluding current user)
          const { data: profilesWithLocation, error: profilesError } = await supabase
            .from("profiles")
            .select("user_id")
            .eq("cashier_assigned_location_id", editFormData.cashierAssignedLocationId)
            .neq("user_id", userToEdit.user_id); // Exclude current cashier
          
          if (profilesError) throw profilesError;
          
          // If any profiles have this location, check if they're cashiers
          if (profilesWithLocation && profilesWithLocation.length > 0) {
            const userIds = profilesWithLocation.map(p => p.user_id);
            const { data: cashierRoles, error: rolesError } = await supabase
              .from("organization_memberships")
              .eq("organization_id", organizationId!)
              .eq("is_active", true)
              .select("user_id")
              .in("user_id", userIds)
              .eq("role", "cashier");
            
            if (rolesError) throw rolesError;
            
            // Only throw error if we found an actual cashier (excluding the current one)
            if (cashierRoles && cashierRoles.length > 0) {
              throw new Error("This location already has a cashier assigned. Each location can only have one cashier.");
            }
          }

          updateData.cashier_assigned_location_id = editFormData.cashierAssignedLocationId;
          updateData.cashier_assigned_engineer_id = null; // Clear direct assignment when using location
        } else if (editFormData.cashierAssignedEngineerId && editFormData.cashierAssignedEngineerId !== "none") {
          // Fallback to direct engineer assignment
          // Check if engineer already has a cashier (unless it's the current cashier being edited)
          const { data: existingCashier, error: checkError } = await supabase
            .from("profiles")
            .select("user_id")
            .eq("cashier_assigned_engineer_id", editFormData.cashierAssignedEngineerId)
            .neq("user_id", userToEdit.user_id) // Exclude current cashier
            .limit(1);

          if (checkError) throw checkError;

          if (existingCashier && existingCashier.length > 0) {
            throw new Error("This engineer already has a cashier assigned. Each engineer can only have one cashier.");
          }
          
          updateData.cashier_assigned_engineer_id = editFormData.cashierAssignedEngineerId;
          updateData.cashier_assigned_location_id = null; // Clear location assignment when using direct
        } else {
          // Clear both if neither is selected
          updateData.cashier_assigned_engineer_id = null;
          updateData.cashier_assigned_location_id = null;
        }
      } else {
        // Clear if role is not cashier
        updateData.cashier_assigned_engineer_id = null;
        updateData.cashier_assigned_location_id = null;
      }
      
      const { error: profileError } = await supabase
        .from("profiles")
        .update(updateData)
        .eq("user_id", userToEdit.user_id);

      if (profileError) throw profileError;

      // Keep still-pending immediate-supervisor-stage expenses pointed at the
      // CURRENT reporting_engineer_id. Best-effort/idempotent: safe to run on
      // every save (not just when the supervisor actually changed) since it
      // only ever sets assigned_reviewer_id/assigned_engineer_id to whatever
      // reporting_engineer_id already is. Scoped to statuses that have not
      // been verified at any hierarchy tier yet (submitted/edited/
      // under_review) and to tiers that mean "immediate supervisor" (null or
      // team_leader/executive) — level_1_verified/level_2_verified, terminal
      // statuses, and engineer/admin-tier expenses are never touched, so
      // completed history and later-tier work are never rewound. A failure
      // here is non-fatal: expense_hierarchy_reviewer_can_act's own current-
      // supervisor fallback still authorizes the new supervisor even if this
      // best-effort reassignment doesn't run.
      if (roleShowsImmediateSupervisor(editFormData.role) && updateData.reporting_engineer_id) {
        const { error: reassignError } = await supabase
          .from("expenses")
          .update({
            assigned_reviewer_id: updateData.reporting_engineer_id,
            assigned_engineer_id: updateData.reporting_engineer_id,
          })
          .eq("organization_id", organizationId!)
          .eq("user_id", userToEdit.user_id)
          .in("status", ["submitted", "edited", "under_review"])
          .or("approval_tier.is.null,approval_tier.in.(team_leader,executive)");
        if (reassignError) {
          console.error(
            "Error reassigning pending expenses to new immediate supervisor:",
            reassignError,
          );
        }
      }

      // If location assignment changed, trigger sync of engineers
      if (editFormData.role === "cashier" && updateData.cashier_assigned_location_id) {
        const { error: syncError } = await supabase.rpc('sync_engineers_with_location_cashier', {
          location_id_param: updateData.cashier_assigned_location_id
        });
        if (syncError) {
          console.error("Error syncing engineers with location cashier:", syncError);
          // Don't throw - this is a background sync
        }
      }

      // Update role - update existing membership.
      // IMPORTANT: select the updated row back so we can detect a silent no-op.
      // RLS can allow the statement yet match 0 rows (e.g. the editor is not an
      // active admin of this org), which returns no error but changes nothing.
      if (!organizationId) throw new Error("Organization not found");
      const { data: updatedMembership, error: updateRoleError } = await supabase
        .from("organization_memberships")
        .update({
          role: editFormData.role,
          is_accountant_cashier:
            editFormData.role === "cashier" && cashierAccountantModeEnabled
              ? editFormData.isAccountantCashier
              : false,
        })
        .eq("organization_id", organizationId)
        .eq("user_id", userToEdit.user_id)
        .select("user_id, role");

      if (updateRoleError) throw updateRoleError;

      if (!updatedMembership || updatedMembership.length === 0) {
        throw new Error(
          "Role was not updated. The change was blocked by access rules — make sure you are signed in as an active administrator of this organization and try again.",
        );
      }

      const savedRole = updatedMembership[0]?.role;
      if (savedRole && savedRole !== editFormData.role) {
        throw new Error(
          `Role did not change (still "${savedRole}"). Please refresh and try again, or contact support if it persists.`,
        );
      }

      // Update engineer locations if role is engineer
      if (editFormData.role === "engineer") {
        // Delete existing location assignments for this org
        const { error: deleteError } = await supabase
          .from("engineer_locations")
          .delete()
          .eq("engineer_id", userToEdit.user_id)
          .eq("organization_id", organizationId);

        if (deleteError) throw deleteError;

        // Insert new location assignment (only one location allowed)
        if (editFormData.locationId && editFormData.locationId !== "none") {
          const { error: locationError } = await supabase
            .from("engineer_locations")
            .insert({
              engineer_id: userToEdit.user_id,
              location_id: editFormData.locationId,
              organization_id: organizationId,
            });

          if (locationError) throw locationError;
        }
      } else {
        // Remove location assignments if role is not engineer
        const { error: deleteError } = await supabase
          .from("engineer_locations")
          .delete()
          .eq("engineer_id", userToEdit.user_id)
          .eq("organization_id", organizationId);

        if (deleteError) throw deleteError;
      }

      if (organizationId && teamsEnabled) {
        await supabase
          .from("team_members")
          .delete()
          .eq("organization_id", organizationId)
          .eq("user_id", userToEdit.user_id);
        if (
          editFormData.role === "employee" &&
          editFormData.teamId &&
          editFormData.teamId !== "none"
        ) {
          const { error: teamMemErr } = await supabase.from("team_members").insert({
            team_id: editFormData.teamId,
            user_id: userToEdit.user_id,
            organization_id: organizationId,
          });
          if (teamMemErr) console.error("team_members insert:", teamMemErr);
        }
      }

      toast({
        title: "User Updated",
        description: `${editFormData.name}'s information has been updated successfully`,
      });

      if (organizationId) {
        void queryClient.invalidateQueries({ queryKey: ["org-membership-roles", organizationId] });
      }

      setEditDialogOpen(false);
      setUserToEdit(null);
      
      // Reload engineer locations
      const { data: elData, error: elError } = await supabase
        .from("engineer_locations")
        .select("engineer_id, location_id");
      if (!elError && elData) {
        const assignments: Record<string, string> = {};
        elData.forEach((el: any) => {
          // Only store the first location for each engineer (one location per engineer)
          if (!assignments[el.engineer_id]) {
            assignments[el.engineer_id] = el.location_id;
          }
        });
        setEngineerLocations(assignments);
      }
      
      // Reload users list
      if (organizationId) {
        setListLoading(true);
        try {
          setUsers(await fetchUserManagementList(organizationId, cachedRolesById));
        } catch (e) {
          console.error("Error loading users list:", e);
        } finally {
          setListLoading(false);
        }
      }
    } catch (error: any) {
      console.error("Error updating user:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update user",
      });
    } finally {
      setUpdating(false);
    }
  };

  const handleResetPassword = async () => {
    if (!userToEdit || !user?.email) return;

    // Verify admin password first
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: adminPassword,
      });

      if (signInError) {
        toast({
          variant: "destructive",
          title: "Authentication Failed",
          description: "Your admin password is incorrect",
        });
        return;
      }

      // Re-authenticate the admin after password verification
      // (signInWithPassword changes the session, so we need to restore it)
      // For now, we'll proceed with the password reset

      // Check if user is admin (can't reset admin passwords)
      if (userToEdit.role === "admin") {
        toast({
          variant: "destructive",
          title: "Cannot Reset Password",
          description: "Admin passwords cannot be reset through this interface",
        });
        setResetPasswordDialogOpen(false);
        setAdminPassword("");
        setNewUserPassword("");
        return;
      }

      // Validate new password
      if (newUserPassword.length < 8) {
        toast({
          variant: "destructive",
          title: "Invalid Password",
          description: "Password must be at least 8 characters long",
        });
        return;
      }

      // Show confirmation dialog
      setResetPasswordConfirmOpen(true);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to verify admin password",
      });
    }
  };

  const confirmResetPassword = async () => {
    if (!userToEdit) return;

    try {
      setResettingPassword(true);
      setResetPasswordConfirmOpen(false);

      // Call Supabase Edge Function to reset password
      // The edge function will use service role to update the password
      const data = await invokeAdminEdgeFunction<{ success?: boolean; error?: string }>(
        "admin-reset-password",
        {
          target_user_id: userToEdit.user_id,
          new_password: newUserPassword,
        },
      );

      if (data?.success) {
        setResetPasswordValue(newUserPassword);
        setResetPasswordSuccessOpen(true);
        setResetPasswordDialogOpen(false);
        setAdminPassword("");
        setNewUserPassword("");
        
        toast({
          title: "Password Reset",
          description: `Password has been reset for ${userToEdit.name}. Please copy and share the new password securely.`,
        });
      } else {
        throw new Error(data?.error || "Failed to reset password");
      }
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to reset password",
      });
    } finally {
      setResettingPassword(false);
    }
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(resetPasswordValue);
      setPasswordCopied(true);
      setTimeout(() => setPasswordCopied(false), 2000);
      toast({
        title: "Copied",
        description: "Password copied to clipboard",
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to copy password",
      });
    }
  };

  const handleDeleteUser = async () => {
    if (!userToDelete || !organizationId) return;

    try {
      setDeleting(true);

      // Routes through the Edge Function so the Supabase Auth account is
      // also suspended (ban_duration), not just the DB-side is_active
      // flags -- a deactivated user's existing JWT can otherwise remain
      // valid until it naturally expires.
      const { data, error } = await supabase.functions.invoke("admin-set-user-auth-status", {
        body: { organization_id: organizationId, target_user_id: userToDelete.user_id, action: "deactivate" },
      });

      if (error) throw error;
      if (data && (data as { success?: boolean }).success === false) {
        throw new Error((data as { error?: string }).error || "Failed to deactivate user");
      }

      toast({
        title: "User deactivated",
        description: `${userToDelete.name} can no longer sign in. Their expenses, approvals, audit history and attachments are preserved.`,
      });

      if (organizationId) {
        void queryClient.invalidateQueries({ queryKey: ["org-membership-roles", organizationId] });
      }

      setDeleteDialogOpen(false);
      setUserToDelete(null);

      // Reload users list
      if (organizationId) {
        setListLoading(true);
        try {
          setUsers(await fetchUserManagementList(organizationId, cachedRolesById));
        } catch (e) {
          console.error("Error loading users list:", e);
        } finally {
          setListLoading(false);
        }
      }
    } catch (error: any) {
      console.error("Error deactivating user:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to deactivate user",
      });
    } finally {
      setDeleting(false);
    }
  };

  const [reactivatingUserId, setReactivatingUserId] = useState<string | null>(null);

  const handleReactivateUser = async (user: UserManagementListRow) => {
    if (!organizationId) return;
    try {
      setReactivatingUserId(user.user_id);
      const { data, error } = await supabase.functions.invoke("admin-set-user-auth-status", {
        body: { organization_id: organizationId, target_user_id: user.user_id, action: "reactivate" },
      });
      if (error) throw error;
      if (data && (data as { success?: boolean }).success === false) {
        throw new Error((data as { error?: string }).error || "Failed to reactivate user");
      }
      toast({ title: "User reactivated", description: `${user.name} can sign in again. Their history is unchanged.` });
      void queryClient.invalidateQueries({ queryKey: ["org-membership-roles", organizationId] });
      setListLoading(true);
      try {
        setUsers(await fetchUserManagementList(organizationId, cachedRolesById));
      } finally {
        setListLoading(false);
      }
    } catch (error: any) {
      console.error("Error reactivating user:", error);
      toast({ variant: "destructive", title: "Error", description: error.message || "Failed to reactivate user" });
    } finally {
      setReactivatingUserId(null);
    }
  };


  if (userRole !== "admin") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-2xl border-0 bg-white/80 backdrop-blur-sm">
          <CardContent className="p-8 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-red-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">{t("common:accessDenied.title")}</h1>
            <p className="text-gray-600">{t("admin:users.accessDeniedDescription")}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const scrollToCreateUser = () => setActiveSection("create");

  return (
    <div className="space-y-4 sm:space-y-6 lg:space-y-8 relative">
      {/* Mobile-optimized Header Section */}
      <div className="text-center space-y-3 sm:space-y-4">
        <div className="inline-flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl sm:rounded-2xl shadow-lg">
          <UserPlus className="h-6 w-6 sm:h-8 sm:w-8 text-white" />
        </div>
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
          {t("admin:users.title")}
        </h1>
        <p className="text-sm sm:text-base lg:text-lg text-gray-600 max-w-2xl mx-auto px-4">
          {t("admin:users.description")}
        </p>
      </div>

      {/* Section navigation tabs */}
      <div className="flex gap-2 flex-wrap">
        <Button
          variant={activeSection === "list" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveSection("list")}
          className="flex items-center gap-1.5"
        >
          <Table2 className="h-4 w-4" />
          {t("admin:users.allUsers", { defaultValue: "Users" })}
        </Button>
        <Button
          variant={activeSection === "create" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveSection("create")}
          className="flex items-center gap-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white"
          style={activeSection !== "create" ? { background: "", color: "" } : {}}
        >
          <UserPlus className="h-4 w-4" />
          {t("admin:users.createUser", { defaultValue: "Create User" })}
        </Button>
        <Button
          variant={activeSection === "bulk" ? "default" : "outline"}
          size="sm"
          onClick={() => setActiveSection("bulk")}
          className="flex items-center gap-1.5"
        >
          <Upload className="h-4 w-4" />
          {t("admin:users.bulkUpload", { defaultValue: "Bulk Upload" })}
        </Button>
      </div>

      {/* Users List Card */}
      {activeSection === "list" && <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardHeader className="p-4 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
              <div>
                <CardTitle className="text-lg sm:text-xl font-bold">{t("admin:users.allUsers")}</CardTitle>
                <CardDescription className="text-xs sm:text-sm">{t("admin:users.allUsersDescription")}</CardDescription>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {userRole === "admin" && activityInsightsEnabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate("/admin/user-activity")}
                    className="text-xs sm:text-sm border-blue-200 text-blue-700 hover:bg-blue-50"
                  >
                    <Activity className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    <span className="hidden sm:inline">Activity Insights</span>
                    <span className="sm:hidden">Activity</span>
                  </Button>
                )}
                <Button
                  onClick={scrollToCreateUser}
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white transition-colors duration-150 text-xs sm:text-sm"
                  size="sm"
                >
                  <UserPlus className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                  <span className="hidden sm:inline">{t("admin:users.createUser")}</span>
                  <span className="sm:hidden">{t("admin:users.create")}</span>
                </Button>
                <Button
                  variant={viewMode === "table" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setViewMode("table")}
                  className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm"
                >
                  <Table2 className="h-3 w-3 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">{t("admin:users.table")}</span>
                </Button>
                {!isMobile && (
                <Button
                  variant={viewMode === "hierarchical" ? "default" : "outline"}
                  size="sm"
                  onClick={() => setViewMode("hierarchical")}
                  className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm"
                >
                  <Network className="h-3 w-3 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">{t("admin:users.hierarchy")}</span>
                </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 pt-0">
            {/* Search Bar */}
            <div className="mb-4 flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder={t(getSearchPlaceholderKey({ includeRole: true }), {
                    defaultValue: showEmployeeIdField
                      ? "Search by name, email, employee ID, or role…"
                      : "Search by name, email, or role…",
                  })}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                />
              </div>
              {teamsEnabled && teams.length > 0 && (
                <Select value={teamFilter} onValueChange={setTeamFilter}>
                  <SelectTrigger className="w-full sm:w-[220px]">
                    <SelectValue placeholder="Filter by team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All teams</SelectItem>
                    <SelectItem value="none">No team</SelectItem>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="mb-4 flex gap-1" role="tablist" aria-label="Filter users by status">
              {(["active", "deactivated", "all"] as const).map((status) => (
                <Button
                  key={status}
                  type="button"
                  variant={userStatusFilter === status ? "default" : "outline"}
                  size="sm"
                  onClick={() => setUserStatusFilter(status)}
                  className="text-xs sm:text-sm capitalize"
                >
                  {status === "active" ? "Active" : status === "deactivated" ? "Deactivated" : "All"}
                </Button>
              ))}
            </div>
          </CardContent>
          <CardContent className="p-0 pt-0">
            {viewMode === "table" ? (
            isMobile ? (
              <div className="space-y-2 px-1 py-2">
                {listProgress.status !== "idle" && (
                  <div className="px-1 py-2">
                    <AsyncOperationProgress
                      status={listProgress.status}
                      title={listProgress.phase}
                      showSuccess={listProgress.status === "success"}
                      compact={listProgress.status === "running"}
                    />
                  </div>
                )}
                {listLoading ? null : filteredUsers.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">{t("admin:users.noUsersMatch")}</p>
                  ) : (
                    <>
                    <div className="space-y-2">
                      {pagedUsers.map(u => (
                        <div key={u.user_id} className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-accent transition-colors" onClick={() => openUserDrawer(u)}>
                          <div className="min-w-0 flex-1">
                            <div className="font-medium text-sm truncate">{u.name || "—"}</div>
                            <div className="text-xs text-muted-foreground truncate">{u.email || "—"}</div>
                          </div>
                          <div className="flex flex-col items-end gap-1 shrink-0">
                            <RoleBadgeWithLabels role={u.role} />
                            <span className="text-xs font-medium tabular-nums text-muted-foreground">{formatINR(Number(u.balance ?? 0))}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <ListPagination
                      page={clampedUsersPage}
                      pageSize={usersPageSize}
                      totalItems={filteredUsers.length}
                      onPageChange={setUsersPage}
                      onPageSizeChange={setUsersPageSize}
                    />
                    </>
                  )}
              </div>
            ) : (
            <>
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <div className="max-h-[440px] overflow-y-auto min-h-[400px]">
                <table className="min-w-full text-xs sm:text-sm">
                  <thead className="bg-slate-50 text-left sticky top-0 z-10">
                  <tr>
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[140px]">Name / Email</th>
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[120px] hidden sm:table-cell">Email</th>
                      {showEmployeeIdField ? (
                        <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[90px] hidden md:table-cell">
                          Employee ID
                        </th>
                      ) : null}
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[100px]">Role</th>
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[120px] hidden md:table-cell">
                        Immediate supervisor
                      </th>
                      {teamsEnabled ? (
                        <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[100px] hidden lg:table-cell">
                          Team
                        </th>
                      ) : null}
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 bg-slate-50 min-w-[100px] hidden sm:table-cell">Balance</th>
                      <th className="px-2 sm:px-4 py-2 sm:py-3 font-semibold text-slate-700 text-right bg-slate-50 min-w-[120px]">Balance / Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {listProgress.status !== "idle" && (
                    <tr>
                      <td colSpan={showEmployeeIdField ? 7 : 6} className="px-4 py-3">
                        <AsyncOperationProgress
                          status={listProgress.status}
                          title={listProgress.phase}
                          showSuccess={listProgress.status === "success"}
                          compact={listProgress.status === "running"}
                        />
                      </td>
                    </tr>
                  )}
                  {listLoading ? null : users.length === 0 ? (
                    <tr>
                      <td className="px-4 py-4" colSpan={showEmployeeIdField ? 7 : 6}>{t("admin:users.noUsers")}</td>
                    </tr>
                  ) : filteredUsers.length === 0 ? (
                    <tr>
                      <td className="px-4 py-4" colSpan={showEmployeeIdField ? 7 : 6}>{t("admin:users.noUsersMatch")}</td>
                    </tr>
                  ) : (
                    <>
                      {pagedUsers.map(u => (
                      <tr key={u.user_id} className="border-t hover:bg-slate-50 cursor-pointer" onClick={() => openUserDrawer(u)}>
                        <td className="px-2 sm:px-4 py-2 sm:py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{u.name || "-"}</span>
                            {!u.is_active && (
                              <span className="inline-flex items-center rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                                Deactivated
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground sm:hidden mt-1">{u.email || "-"}</div>
                        </td>
                        <td className="px-2 sm:px-4 py-2 sm:py-3 hidden sm:table-cell">{u.email || "-"}</td>
                        {showEmployeeIdField ? (
                          <td className="px-2 sm:px-4 py-2 sm:py-3 hidden md:table-cell font-mono text-xs">
                            {u.employee_id || "—"}
                          </td>
                        ) : null}
                        <td className="px-2 sm:px-4 py-2 sm:py-3">
                          <RoleBadgeWithLabels role={u.role} />
                        </td>
                        <td className="px-2 sm:px-4 py-2 sm:py-3 hidden md:table-cell">
                          {roleShowsImmediateSupervisor(u.role) ? (
                            u.assigned_engineer_name ? (
                              <span className="text-slate-700 font-medium">{u.assigned_engineer_name}</span>
                            ) : (
                              <span className="text-slate-400 italic">Not assigned</span>
                            )
                          ) : u.role === "cashier" ? (
                            u.cashier_assigned_location_name ? (
                              <span className="text-slate-700 font-medium">{u.cashier_assigned_location_name}</span>
                            ) : (
                              <span className="text-slate-400 italic">Not assigned</span>
                            )
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        {teamsEnabled ? (
                          <td className="px-2 sm:px-4 py-2 sm:py-3 hidden lg:table-cell text-slate-700">
                            {u.team_name || <span className="text-slate-400 italic">—</span>}
                          </td>
                        ) : null}
                        <td className="px-2 sm:px-4 py-2 sm:py-3 font-medium hidden sm:table-cell">{formatINR(Number(u.balance ?? 0))}</td>
                        <td className="px-2 sm:px-4 py-2 sm:py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex flex-col sm:flex-row items-end gap-2 sm:gap-0">
                            <div className="sm:hidden font-medium text-right">{formatINR(Number(u.balance ?? 0))}</div>
                            <div className="flex items-center justify-end gap-1 sm:gap-2">
                              <Button variant="outline" size="sm" onClick={() => openUserDrawer(u)} className="text-xs sm:text-sm px-2 sm:px-3">
                                <span className="hidden sm:inline">View</span>
                                <Eye className="h-3 w-3 sm:h-4 sm:w-4 sm:hidden" />
                            </Button>
                              <Button variant="outline" size="sm" onClick={() => openEditDialog(u)} className="px-2 sm:px-3">
                                <Edit className="h-3 w-3 sm:h-4 sm:w-4" />
                              </Button>
                              {u.is_active ? (
                                <Button variant="destructive" size="sm" onClick={() => openDeleteDialog(u)} className="px-2 sm:px-3" title="Deactivate user">
                                  <Trash2 className="h-3 w-3 sm:h-4 sm:w-4" />
                                </Button>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleReactivateUser(u)}
                                  disabled={reactivatingUserId === u.user_id}
                                  className="px-2 sm:px-3 text-xs sm:text-sm"
                                  title="Reactivate user"
                                >
                                  {reactivatingUserId === u.user_id ? "..." : "Reactivate"}
                                </Button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
            </div>
            </div>
            <ListPagination
              page={clampedUsersPage}
              pageSize={usersPageSize}
              totalItems={filteredUsers.length}
              onPageChange={setUsersPage}
              onPageSizeChange={setUsersPageSize}
            />
            </>
            )
            ) : isMobile ? (
            <div className="space-y-2 px-1 py-2" data-testid="mobile-user-cards-hierarchy">
              {listLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading users...</p>
              ) : filteredUsers.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">{t("admin:users.noUsersMatch")}</p>
                ) : (
                  <div className="space-y-2">
                    {filteredUsers.map(u => (
                      <div key={u.user_id} className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-accent transition-colors" onClick={() => openUserDrawer(u)}>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-sm truncate">{u.name || "—"}</div>
                          <div className="text-xs text-muted-foreground truncate">{u.email || "—"}</div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <RoleBadgeWithLabels role={u.role} />
                          <span className="text-xs font-medium tabular-nums text-muted-foreground">{formatINR(Number(u.balance ?? 0))}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
            </div>
            ) : (
            <div className="p-6 min-h-[400px]">
              {listLoading ? (
                <div className="text-center py-8 text-gray-500">Loading hierarchy...</div>
              ) : (() => {
                const hierarchyData = buildHierarchy();
                
                // Filter hierarchy by location
                const search = searchTerm.trim().toLowerCase();
                const filteredHierarchyByLocation = search
                  ? hierarchyData.hierarchyByLocation
                      .map((loc) => ({
                        ...loc,
                        engineers: loc.engineers.filter(
                          (h) =>
                            hierarchyNodeMatchesSearch(h, search, roleLabels) ||
                            loc.location.name.toLowerCase().includes(search),
                        ),
                      }))
                      .filter((loc) => loc.engineers.length > 0)
                  : hierarchyData.hierarchyByLocation;

                const filteredUnassignedEngineers = search
                  ? hierarchyData.unassignedEngineers.filter((h) =>
                      hierarchyNodeMatchesSearch(h, search, roleLabels),
                    )
                  : hierarchyData.unassignedEngineers;
                
                return (
                  <div className="space-y-8">
                    {/* Summary Stats */}
                    <div
                      className={`grid grid-cols-2 gap-3 sm:gap-4 mb-4 sm:mb-6 ${
                        teamLeaderTierEnabled && executiveTierEnabled
                          ? "sm:grid-cols-3 lg:grid-cols-6"
                          : teamLeaderTierEnabled || executiveTierEnabled
                            ? "sm:grid-cols-3 lg:grid-cols-5"
                            : "sm:grid-cols-2 md:grid-cols-4"
                      }`}
                    >
                      <div className="bg-blue-50 p-3 sm:p-4 rounded-lg border border-blue-200">
                        <div className="text-xl sm:text-2xl font-bold text-blue-900">{hierarchyData.totalEngineers}</div>
                        <div className="text-xs sm:text-sm text-blue-700">Managers</div>
                      </div>
                      {teamLeaderTierEnabled && (
                        <div className="bg-amber-50 p-3 sm:p-4 rounded-lg border border-amber-200">
                          <div className="text-xl sm:text-2xl font-bold text-amber-900">
                            {hierarchyData.totalTeamLeaders}
                          </div>
                          <div className="text-xs sm:text-sm text-amber-800">{teamLeaderLabel}s</div>
                        </div>
                      )}
                      {executiveTierEnabled && (
                        <div className="bg-teal-50 p-3 sm:p-4 rounded-lg border border-teal-200">
                          <div className="text-xl sm:text-2xl font-bold text-teal-900">
                            {hierarchyData.totalExecutives}
                          </div>
                          <div className="text-xs sm:text-sm text-teal-800">{executiveLabel}s</div>
                        </div>
                      )}
                      <div className="bg-purple-50 p-3 sm:p-4 rounded-lg border border-purple-200">
                        <div className="text-xl sm:text-2xl font-bold text-purple-900">{hierarchyData.totalCashiers}</div>
                        <div className="text-xs sm:text-sm text-purple-700">Cashiers</div>
                      </div>
                      <div className="bg-green-50 p-3 sm:p-4 rounded-lg border border-green-200">
                        <div className="text-xl sm:text-2xl font-bold text-green-900">{hierarchyData.totalEmployees}</div>
                        <div className="text-xs sm:text-sm text-green-700">Employees</div>
                      </div>
                      <div className="bg-gray-50 p-3 sm:p-4 rounded-lg border border-gray-200">
                        <div className="text-xl sm:text-2xl font-bold text-gray-900">{hierarchyData.admins.length}</div>
                        <div className="text-xs sm:text-sm text-gray-700">Admins</div>
                      </div>
                    </div>

                    {/* Hierarchy View by Location */}
                    {filteredHierarchyByLocation.length === 0 && filteredUnassignedEngineers.length === 0 ? (
                      <div className="text-center py-8 text-gray-500">No managers found</div>
                    ) : (
                      <div className="space-y-6 sm:space-y-8">
                        {/* Locations with Engineers */}
                        {filteredHierarchyByLocation.map((locationData, locIdx) => (
                          <div key={locationData.location.id} className="border-2 border-indigo-200 rounded-lg p-4 sm:p-6 bg-gradient-to-br from-indigo-50 to-purple-50">
                            {/* Location Header */}
                            <div className="mb-4 sm:mb-6 pb-3 sm:pb-4 border-b border-indigo-200">
                              <div className="flex items-center gap-2 sm:gap-3">
                                <MapPin className="h-5 w-5 sm:h-6 sm:w-6 text-indigo-600" />
                                <h3 className="text-lg sm:text-xl font-bold text-indigo-900">{locationData.location.name}</h3>
                                <Badge variant="outline" className="bg-indigo-100 text-indigo-700 border-indigo-300">
                                  {locationData.engineers.length} Manager{locationData.engineers.length !== 1 ? 's' : ''}
                                </Badge>
                              </div>
                            </div>
                            
                            {/* Location-Based Cashiers - Shown at location level, with managers nested under them */}
                            {locationData.cashiers && locationData.cashiers.length > 0 ? (
                              <div className="mb-4 sm:mb-6 ml-0 sm:ml-4 space-y-4 sm:space-y-6">
                                {locationData.cashiers.map((cashier, cashierIdx) => {
                                  // Count total employees managed by this location cashier (all employees under all managers in this location)
                                  const totalEmployees = locationData.engineers.reduce(
                                    (sum, eng) => sum + eng.engineer.employeeCount,
                                    0,
                                  );
                                  return (
                                    <div key={cashier.user_id || cashierIdx} className="border-2 border-purple-300 rounded-lg p-4 sm:p-6 bg-gradient-to-br from-purple-50 to-amber-50 shadow-md">
                                      {/* Cashier Level */}
                                      <div className="mb-4 sm:mb-6">
                                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0 mb-2">
                                          <div 
                                            className="flex items-center gap-3 sm:gap-4 cursor-pointer hover:opacity-90 transition-opacity duration-150 flex-1 min-w-0"
                                            onClick={() => openUserDrawer(cashier)}
                                          >
                                            <div className="w-12 h-12 sm:w-14 sm:h-14 bg-purple-600 rounded-full flex items-center justify-center text-white font-bold text-lg sm:text-xl flex-shrink-0 shadow-lg">
                                              {cashier.name.charAt(0).toUpperCase()}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              <div className="font-bold text-lg sm:text-xl text-gray-900 truncate">{cashier.name}</div>
                                              <div className="text-sm sm:text-base text-gray-600 truncate">{cashier.email}</div>
                                              <div className="text-sm sm:text-base font-semibold text-purple-700 mt-1">
                                                Balance: {formatINR(Number(cashier.balance ?? 0))}
                                              </div>
                                            </div>
                                            <Badge variant="default" className="bg-purple-600 text-sm sm:text-base px-3 py-1 flex-shrink-0 shadow-md">Cashier</Badge>
                                          </div>
                                          <div className="text-left sm:text-right">
                                            <div className="text-sm sm:text-base text-gray-600 font-medium">Manages</div>
                                            <div className="font-bold text-base sm:text-lg text-gray-900">
                                              {locationData.engineers.length} Manager{locationData.engineers.length !== 1 ? 's' : ''} • {totalEmployees} Employee{totalEmployees !== 1 ? 's' : ''}
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                      
                                      {/* Managers under this cashier */}
                                      {locationData.engineers.length > 0 && (
                                        <div className="ml-0 sm:ml-6 space-y-4 sm:space-y-5">
                                          <div className="text-sm sm:text-base font-bold text-gray-800 mb-3 flex items-center gap-2 border-b border-blue-200 pb-2">
                                            <Settings className="h-4 w-4 text-blue-600" />
                                            <span>Manager{locationData.engineers.length !== 1 ? 's' : ''} ({locationData.engineers.length})</span>
                                          </div>
                                          {locationData.engineers.map((item, idx) => (
                                            <div key={item.engineer.user_id || idx} className="border rounded-lg p-4 sm:p-6 bg-gradient-to-br from-blue-50 to-indigo-50">
                                              {/* Manager Level */}
                                              <div className="mb-3 sm:mb-4">
                                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0 mb-2">
                                                  <div 
                                                    className="flex items-center gap-2 sm:gap-3 cursor-pointer hover:opacity-90 transition-opacity duration-150"
                                                    onClick={() => openUserDrawer(item.engineer)}
                                                  >
                                                    <div className="w-10 h-10 sm:w-12 sm:h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-base sm:text-lg flex-shrink-0">
                                                      {item.engineer.name.charAt(0).toUpperCase()}
                                                    </div>
                                                    <div className="min-w-0 flex-1">
                                                      <div className="font-bold text-base sm:text-lg text-gray-900 truncate">{item.engineer.name}</div>
                                                      <div className="text-xs sm:text-sm text-gray-600 truncate">{item.engineer.email}</div>
                                                      <div className="text-xs sm:text-sm font-semibold text-blue-700 mt-1">
                                                        Balance: {formatINR(Number(item.engineer.balance ?? 0))}
                                                      </div>
                                                    </div>
                                                    <Badge variant="default" className="bg-blue-600 text-xs sm:text-sm flex-shrink-0">Manager</Badge>
                                                  </div>
                                                  <div className="text-left sm:text-right">
                                                    <div className="text-xs sm:text-sm text-gray-600">Team Stats</div>
                                                    <div className="font-semibold text-sm sm:text-base text-gray-900">
                                                      {formatManagerTeamStats(item)}
                                                    </div>
                                                  </div>
                                                </div>
                                              </div>

                                              <UserHierarchySubordinates
                                                item={item}
                                                teamLeaderTierEnabled={teamLeaderTierEnabled}
                                                executiveTierEnabled={executiveTierEnabled}
                                                teamLeaderLabel={teamLeaderLabel}
                                                executiveLabel={executiveLabel}
                                                onUserClick={openUserDrawer}
                                              />
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              /* If no location-based cashiers, show managers directly under location */
                              <div className="space-y-4 sm:space-y-6 ml-0 sm:ml-4">
                                {locationData.engineers.map((item, idx) => (
                                  <div key={item.engineer.user_id || idx} className="border rounded-lg p-4 sm:p-6 bg-gradient-to-br from-blue-50 to-indigo-50">
                                    {/* Manager Level */}
                                    <div className="mb-3 sm:mb-4">
                                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0 mb-2">
                                        <div 
                                          className="flex items-center gap-2 sm:gap-3 cursor-pointer hover:opacity-90 transition-opacity duration-150"
                                          onClick={() => openUserDrawer(item.engineer)}
                                        >
                                          <div className="w-10 h-10 sm:w-12 sm:h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-base sm:text-lg flex-shrink-0">
                                            {item.engineer.name.charAt(0).toUpperCase()}
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <div className="font-bold text-base sm:text-lg text-gray-900 truncate">{item.engineer.name}</div>
                                            <div className="text-xs sm:text-sm text-gray-600 truncate">{item.engineer.email}</div>
                                            <div className="text-xs sm:text-sm font-semibold text-blue-700 mt-1">
                                              Balance: {formatINR(Number(item.engineer.balance ?? 0))}
                                            </div>
                                          </div>
                                          <Badge variant="default" className="bg-blue-600 text-xs sm:text-sm flex-shrink-0">Manager</Badge>
                                        </div>
                                        <div className="text-left sm:text-right">
                                          <div className="text-xs sm:text-sm text-gray-600">Team Stats</div>
                                          <div className="font-semibold text-sm sm:text-base text-gray-900">
                                            {formatManagerTeamStats(item)}
                                          </div>
                                        </div>
                                      </div>
                                    </div>

                                    {/* Cashiers Level - Only one cashier per manager */}
                                    {item.cashiers.length > 0 && (
                                      <div className="ml-0 sm:ml-4 md:ml-8 mb-3 sm:mb-4">
                                        <div className="text-xs sm:text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
                                          <div className="w-12 sm:w-24 h-0.5 bg-purple-300"></div>
                                          <span>Cashier{item.cashiers.length !== 1 ? 's' : ''} ({item.cashiers.length})</span>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-3">
                                          {item.cashiers.map((cashier, cIdx) => {
                                            const employeesManaged = item.engineer.employeeCount;
                                            return (
                                              <div 
                                                key={cashier.user_id || `cashier-${cIdx}-${cashier.name}`} 
                                                className="bg-white rounded-lg p-4 border border-purple-200 shadow-sm cursor-pointer hover:border-purple-300 transition-colors"
                                                onClick={() => openUserDrawer(cashier)}
                                              >
                                                <div className="flex items-center gap-2 mb-2">
                                                  <div className="w-8 h-8 bg-purple-600 rounded-full flex items-center justify-center text-white font-bold text-sm">
                                                    {cashier.name.charAt(0).toUpperCase()}
                                                  </div>
                                                  <div className="flex-1 min-w-0">
                                                    <div className="font-semibold text-sm text-gray-900 truncate">{cashier.name}</div>
                                                    <div className="text-xs text-gray-500 truncate">{cashier.email}</div>
                                                  </div>
                                                  <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-300 text-xs">Cashier</Badge>
                                                </div>
                                                <div className="text-xs text-gray-600 space-y-1">
                                                  <div>Balance: {formatINR(Number(cashier.balance ?? 0))}</div>
                                                  <div>Manages: {employeesManaged} employee{employeesManaged !== 1 ? 's' : ''}</div>
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      </div>
                                    )}

                                    <UserHierarchySubordinates
                                      item={item}
                                      teamLeaderTierEnabled={teamLeaderTierEnabled}
                                      executiveTierEnabled={executiveTierEnabled}
                                      teamLeaderLabel={teamLeaderLabel}
                                      executiveLabel={executiveLabel}
                                      onUserClick={openUserDrawer}
                                    />
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                        
                        {/* Unassigned Managers (no location) */}
                        {filteredUnassignedEngineers.length > 0 && (
                          <div className="border-2 border-gray-200 rounded-lg p-4 sm:p-6 bg-gradient-to-br from-gray-50 to-slate-50">
                            <div className="mb-4 sm:mb-6 pb-3 sm:pb-4 border-b border-gray-200">
                              <div className="flex items-center gap-2 sm:gap-3">
                                <AlertCircle className="h-5 w-5 sm:h-6 sm:w-6 text-gray-600" />
                                <h3 className="text-lg sm:text-xl font-bold text-gray-900">Unassigned Managers</h3>
                                <Badge variant="outline" className="bg-gray-100 text-gray-700 border-gray-300">
                                  {filteredUnassignedEngineers.length} Manager{filteredUnassignedEngineers.length !== 1 ? 's' : ''}
                                </Badge>
                              </div>
                              <p className="text-xs sm:text-sm text-gray-600 mt-2">Managers without location assignments</p>
                            </div>
                            
                            <div className="space-y-4 sm:space-y-6">
                              {filteredUnassignedEngineers.map((item, idx) => (
                                <div key={item.engineer.user_id || idx} className="border rounded-lg p-4 sm:p-6 bg-gradient-to-br from-blue-50 to-indigo-50">
                                  {/* Manager Level */}
                                  <div className="mb-3 sm:mb-4">
                                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0 mb-2">
                                      <div 
                                        className="flex items-center gap-2 sm:gap-3 cursor-pointer hover:opacity-90 transition-opacity duration-150"
                                        onClick={() => openUserDrawer(item.engineer)}
                                      >
                                        <div className="w-10 h-10 sm:w-12 sm:h-12 bg-blue-600 rounded-full flex items-center justify-center text-white font-bold text-base sm:text-lg flex-shrink-0">
                                          {item.engineer.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className="font-bold text-base sm:text-lg text-gray-900 truncate">{item.engineer.name}</div>
                                          <div className="text-xs sm:text-sm text-gray-600 truncate">{item.engineer.email}</div>
                                          <div className="text-xs sm:text-sm font-semibold text-blue-700 mt-1">
                                            Balance: {formatINR(Number(item.engineer.balance ?? 0))}
                                          </div>
                                        </div>
                                        <Badge variant="default" className="bg-blue-600 text-xs sm:text-sm flex-shrink-0">Manager</Badge>
                                      </div>
                                      <div className="text-left sm:text-right">
                                        <div className="text-xs sm:text-sm text-gray-600">Team Stats</div>
                                        <div className="font-semibold text-sm sm:text-base text-gray-900">
                                          {formatManagerTeamStats(item)}
                                        </div>
                                      </div>
                                    </div>
                                  </div>

                                  <UserHierarchySubordinates
                                    item={item}
                                    teamLeaderTierEnabled={teamLeaderTierEnabled}
                                    executiveTierEnabled={executiveTierEnabled}
                                    teamLeaderLabel={teamLeaderLabel}
                                    executiveLabel={executiveLabel}
                                    onUserClick={openUserDrawer}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Unassigned Section */}
                    {(hierarchyData.unassignedCashiers.length > 0 ||
                      hierarchyData.unassignedEmployees.length > 0 ||
                      hierarchyData.unassignedTeamLeaders.length > 0 ||
                      hierarchyData.unassignedExecutives.length > 0) && (
                      <div className="border rounded-lg p-6 bg-gray-50 mt-6">
                        <div className="font-bold text-lg text-gray-900 mb-4">Unassigned Users</div>
                        {hierarchyData.unassignedCashiers.length > 0 && (
                          <div className="mb-4">
                            <div className="text-sm font-semibold text-gray-700 mb-2">Cashiers ({hierarchyData.unassignedCashiers.length})</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                              {hierarchyData.unassignedCashiers.map((cashier, idx) => (
                                <div 
                                  key={cashier.user_id || idx} 
                                  className="bg-white rounded p-2 border border-gray-300 text-sm cursor-pointer hover:border-gray-400 transition-colors"
                                  onClick={() => openUserDrawer(cashier)}
                                >
                                  <div>{cashier.name} ({cashier.email})</div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Balance: {formatINR(Number(cashier.balance ?? 0))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {executiveTierEnabled && hierarchyData.unassignedExecutives.length > 0 && (
                          <div className="mb-4">
                            <div className="text-sm font-semibold text-gray-700 mb-2">
                              {executiveLabel}s ({hierarchyData.unassignedExecutives.length})
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                              {hierarchyData.unassignedExecutives.map((user, idx) => (
                                <div
                                  key={user.user_id || idx}
                                  className="bg-white rounded p-2 border border-teal-200 text-sm cursor-pointer hover:border-teal-300 transition-colors"
                                  onClick={() => openUserDrawer(user)}
                                >
                                  <div>{user.name} ({user.email})</div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Balance: {formatINR(Number(user.balance ?? 0))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {teamLeaderTierEnabled && hierarchyData.unassignedTeamLeaders.length > 0 && (
                          <div className="mb-4">
                            <div className="text-sm font-semibold text-gray-700 mb-2">
                              {teamLeaderLabel}s ({hierarchyData.unassignedTeamLeaders.length})
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                              {hierarchyData.unassignedTeamLeaders.map((user, idx) => (
                                <div
                                  key={user.user_id || idx}
                                  className="bg-white rounded p-2 border border-amber-200 text-sm cursor-pointer hover:border-amber-300 transition-colors"
                                  onClick={() => openUserDrawer(user)}
                                >
                                  <div>{user.name} ({user.email})</div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Balance: {formatINR(Number(user.balance ?? 0))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {hierarchyData.unassignedEmployees.length > 0 && (
                          <div>
                            <div className="text-sm font-semibold text-gray-700 mb-2">Employees ({hierarchyData.unassignedEmployees.length})</div>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
                              {hierarchyData.unassignedEmployees.map((employee, idx) => (
                                <div 
                                  key={employee.user_id || idx} 
                                  className="bg-white rounded p-2 border border-gray-300 text-sm cursor-pointer hover:border-gray-400 transition-colors"
                                  onClick={() => openUserDrawer(employee)}
                                >
                                  <div>{employee.name} ({employee.email})</div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Balance: {formatINR(Number(employee.balance ?? 0))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            )}
          </CardContent>
        </Card>}

      {activeSection === "bulk" && <Card className="shadow-xl border-0 bg-white/90 backdrop-blur-sm">
        <CardHeader className="bg-gradient-to-r from-emerald-600 to-teal-600 text-white p-6">
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Bulk Users Upload (CSV)
          </CardTitle>
          <CardDescription className="text-emerald-100">
            {showEmployeeIdField
              ? "Upload users with name, employee ID, position, supervisor employee ID, location, and password. Auth emails are generated automatically on the server."
              : "Upload users with name, position, assigned manager, location, and password. Managers and employees can be in the same file."}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-6 space-y-4">
          {organizationId && userRole === "admin" && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50/90 p-3 text-sm text-emerald-950">
              <p className="font-medium">Organization capacity (for this import)</p>
              <p className="mt-1 break-all font-mono text-xs text-emerald-900/90">{organizationId}</p>
              {orgSeatSummaryLoading ? (
                <p className="mt-2 text-muted-foreground">Loading member counts…</p>
              ) : orgSeatSummary ? (
                <p className="mt-2">
                  Active members: <strong>{orgSeatSummary.activeMembers}</strong>
                  {" · "}
                  Max users:{" "}
                  <strong>{orgSeatSummary.maxUsers == null ? "Unlimited" : orgSeatSummary.maxUsers}</strong>
                  {orgSeatSummary.maxUsers != null && (
                    <span className="text-emerald-800/80">
                      {" "}
                      ({Math.max(0, orgSeatSummary.maxUsers - orgSeatSummary.activeMembers)} seats available)
                    </span>
                  )}
                </p>
              ) : (
                <p className="mt-2 text-muted-foreground">Could not load capacity (check permissions or try again).</p>
              )}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div className="space-y-2">
              <Label htmlFor="bulk-users-file">CSV file</Label>
              <Input
                id="bulk-users-file"
                type="file"
                accept=".csv"
                onChange={(e) => setBulkUsersFile(e.target.files?.[0] || null)}
              />
              <p className="text-xs text-gray-600">
                {showEmployeeIdField ? (
                  <>
                    Required columns: <strong>name, employee_id, position, password</strong>. Optional:{" "}
                    <strong>immediate_supervisor_employee_id</strong> (executive / team leader / manager ID — e.g. 5022),{" "}
                    immediate_supervisor_email, location, team_name. Email per employee is optional (auto-generated).
                    Executives and managers must already exist in this org before employee import.
                    Dry run shows supervisor links as: employee_id=5022→Name (executive, id=5022).
                  </>
                ) : (
                  <>
                    Required columns: <strong>name, email, position, password</strong>. Optional:{" "}
                    immediate_supervisor_email (or assigned_manager_email), location. Position/role: employee,
                    team_leader, executive, engineer, admin, cashier.
                  </>
                )}
              </p>
            </div>
            <div className="flex md:flex-col gap-2 items-start">
              <Button type="button" variant="outline" onClick={downloadBulkUsersTemplate}>
                <FileText className="h-4 w-4 mr-2" />
                Download Template
              </Button>
              <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                <Label htmlFor="bulk-users-dry-run" className="text-sm">Dry-run</Label>
                <Switch id="bulk-users-dry-run" checked={bulkUsersDryRun} onCheckedChange={setBulkUsersDryRun} />
              </div>
            </div>
          </div>
          {bulkImportProgress.status !== "idle" && (
            <div className="mb-2">
              <AsyncOperationProgress
                status={bulkImportProgress.status}
                title={bulkImportProgress.phase}
                description={bulkImportProgress.description}
                completed={bulkImportProgress.completed}
                total={bulkImportProgress.total}
                showSuccess={bulkImportProgress.status === "success"}
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={handleBulkUsersUpload} disabled={bulkUsersLoading || !bulkUsersFile}>
              {bulkUsersLoading
                ? (bulkUsersProgress || "Processing...")
                : bulkUsersDryRun
                  ? "Run Dry-Run"
                  : "Upload Users"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setBulkUsersResult(null)}>
              Clear Result
            </Button>
          </div>
          {bulkUsersResult && (
            <pre className="max-h-72 overflow-auto rounded-md border bg-gray-50 p-3 text-xs">
              {JSON.stringify(bulkUsersResult, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>}

      {/* Create User Card */}
      {activeSection === "create" && <>
        <Card id="create-user-section" className="shadow-2xl border-0 bg-white/80 backdrop-blur-sm overflow-hidden">
          <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-2xl font-bold">Create New User</CardTitle>
                <CardDescription className="text-blue-100 mt-1">
                  Add new team members with appropriate access levels
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-8">
            <form onSubmit={handleCreateUser} className="space-y-8">
              {/* Personal Information */}
              <div className="space-y-6">
                <div className="flex items-center gap-2 mb-4">
                  <User className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold text-gray-900">Personal Information</h3>
                </div>
                
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-3">
                    <Label htmlFor="name" className="text-sm font-medium text-gray-700">Full Name *</Label>
                    <div className="relative group">
                      <User className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 group-focus-within:text-blue-600 transition-colors" />
                      <Input
                        id="name"
                        value={formData.name}
                        onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="John Doe"
                        className="pl-10 h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Label htmlFor="email" className="text-sm font-medium text-gray-700">
                      Email address {useEmailAuto ? "(auto-generated)" : "*"}
                    </Label>
                    <div className="relative group">
                      <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 group-focus-within:text-blue-600 transition-colors" />
                      <Input
                        id="email"
                        type="email"
                        value={formData.email}
                        onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                        placeholder="john.doe@company.com"
                        className="pl-10 h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150"
                        required={!useEmailAuto}
                        disabled={useEmailAuto}
                      />
                    </div>
                    {useEmailAuto ? (
                      <p className="text-xs text-muted-foreground">
                        Sign-in email is generated automatically. Employee ID is required.
                      </p>
                    ) : null}
                  </div>

                  {showEmployeeIdField ? (
                    <div className="space-y-3 md:col-span-2">
                      <Label htmlFor="employee_id" className="text-sm font-medium text-gray-700">
                        Employee ID *
                      </Label>
                      <Input
                        id="employee_id"
                        type="text"
                        value={formData.employee_id}
                        onChange={(e) =>
                          setFormData((prev) => ({ ...prev, employee_id: e.target.value }))
                        }
                        placeholder="e.g. EMP001"
                        className="h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150 max-w-md"
                        required={showEmployeeIdField}
                      />
                      <p className="text-xs text-muted-foreground">
                        Unique in your organization. Used for employee ID sign-in on your tenant subdomain when enabled.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Role and Security */}
              <div className="space-y-6">
                <div className="flex items-center gap-2 mb-4">
                  <Shield className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold text-gray-900">Role & Security</h3>
                </div>
                
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-3">
                    <Label htmlFor="role" className="text-sm font-medium text-gray-700">Role *</Label>
                    <div className="relative group">
                      <Settings className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400 group-focus-within:text-blue-600 transition-colors z-10" />
                      <Select
                        value={formData.role}
                        onValueChange={(value: OrgRole) =>
                          setFormData(prev => ({ ...prev, role: value }))
                        }
                      >
                        <SelectTrigger className="pl-10 h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="border-0 shadow-xl">
                          <RoleSelectItems
                            teamLeaderTierEnabled={teamLeaderTierEnabled}
                            executiveTierEnabled={executiveTierEnabled}
                          />
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                   {formData.role === "employee" && teamsEnabled && teams.length > 0 && (
                  <div className="space-y-3">
                    <Label className="text-sm font-medium text-gray-700">Team</Label>
                    <Select
                      value={formData.teamId || "none"}
                      onValueChange={(value) => setFormData((prev) => ({ ...prev, teamId: value }))}
                    >
                      <SelectTrigger className="h-12">
                        <SelectValue placeholder="Select team" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No team</SelectItem>
                        {teams.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                   )}

                   {roleShowsImmediateSupervisor(formData.role) && (
                  <div className="space-y-3">
                    <Label htmlFor="reportingEngineer" className="text-sm font-medium text-gray-700">
                      {immediateSupervisorFieldLabel(formData.role)}
                      {isImmediateSupervisorRequired(formData.role, requireImmediateSupervisor) ? " *" : ""}
                    </Label>
                    <Select
                      value={formData.reportingEngineerId || "none"}
                      onValueChange={(value) => setFormData(prev => ({ ...prev, reportingEngineerId: value }))}
                    >
                         <SelectTrigger className="h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150">
                        <SelectValue placeholder="Select supervisor" />
                      </SelectTrigger>
                      <SelectContent className="border-0 shadow-xl">
                        <SelectItem value="none">Unassigned</SelectItem>
                        {createSupervisorOptions.map((supervisor) => (
                          <SelectItem key={supervisor.user_id} value={supervisor.user_id}>
                            {supervisor.name} ({getRoleLabel(supervisor.role)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">{immediateSupervisorFieldHint(formData.role)}</p>
                  </div>
                   )}

                   {formData.role === "employee" && (
                     <div className="space-y-3">
                       <Label htmlFor="assignedCashier" className="text-sm font-medium text-gray-700">Assign Cashier</Label>
                       <Select
                         value={formData.assignedCashierId || "none"}
                         onValueChange={(value) => setFormData(prev => ({ ...prev, assignedCashierId: value }))}
                       >
                         <SelectTrigger className="h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150">
                           <SelectValue placeholder="Select cashier" />
                         </SelectTrigger>
                         <SelectContent className="border-0 shadow-xl">
                           <SelectItem value="none">Unassigned</SelectItem>
                           {cashiers.map(c => (
                             <SelectItem key={c.id} value={c.id}>
                               {c.name} ({c.email})
                             </SelectItem>
                           ))}
                         </SelectContent>
                       </Select>
                       <p className="text-xs text-gray-500">Employee will return money to this cashier.</p>
                     </div>
                   )}

                   {formData.role === "cashier" && (
                     <div className="space-y-3 md:col-span-2">
                       <div className="space-y-3">
                         <Label htmlFor="cashierLocation" className="text-sm font-medium text-gray-700 flex items-center gap-2">
                           <MapPin className="h-4 w-4 text-blue-600" />
                           Assign Location (Recommended)
                         </Label>
                         <Select
                           value={formData.cashierAssignedLocationId || "none"}
                           onValueChange={(value) => setFormData(prev => ({ ...prev, cashierAssignedLocationId: value, cashierAssignedEngineerId: "none" }))}
                         >
                           <SelectTrigger className="h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150">
                             <SelectValue placeholder="Select location" />
                           </SelectTrigger>
                           <SelectContent className="border-0 shadow-xl">
                             <SelectItem value="none">Unassigned</SelectItem>
                             {locations.filter(loc => {
                               // Filter out locations that already have a cashier assigned
                               const locationHasCashier = users.some(u => 
                                 u.role === "cashier" && 
                                 u.cashier_assigned_location_id === loc.id
                               );
                               return !locationHasCashier;
                             }).map(loc => (
                               <SelectItem key={loc.id} value={loc.id}>
                                 {loc.name}
                               </SelectItem>
                             ))}
                           </SelectContent>
                         </Select>
                         <p className="text-xs text-gray-500">If set, this cashier will manage all managers and employees in this location. Each location can only have one cashier.</p>
                       </div>
                       
                       <div className="space-y-3 border-t pt-3">
                         <Label htmlFor="cashierEngineer" className="text-sm font-medium text-gray-700">OR Assign Manager Directly (Fallback)</Label>
                         <Select
                           value={formData.cashierAssignedEngineerId || "none"}
                           onValueChange={(value) => setFormData(prev => ({ ...prev, cashierAssignedEngineerId: value, cashierAssignedLocationId: "none" }))}
                           disabled={formData.cashierAssignedLocationId && formData.cashierAssignedLocationId !== "none"}
                         >
                           <SelectTrigger className="h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150">
                            <SelectValue placeholder="Select manager" />
                          </SelectTrigger>
                           <SelectContent className="border-0 shadow-xl">
                             <SelectItem value="none">Unassigned (Can manage all)</SelectItem>
                             {engineers.filter(e => {
                               // Filter out engineers who already have a cashier assigned
                               const engineerHasCashier = users.some(u => 
                                 u.role === "cashier" && 
                                 u.cashier_assigned_engineer_name &&
                                 // Find the engineer user by matching name
                                 users.find(eng => eng.role === "engineer" && eng.name === u.cashier_assigned_engineer_name)?.user_id === e.id
                               );
                               return !engineerHasCashier;
                             }).map(e => (
                               <SelectItem key={e.id} value={e.id}>
                                 {e.name} ({e.email})
                               </SelectItem>
                             ))}
                           </SelectContent>
                         </Select>
                         <p className="text-xs text-gray-500">If set, this cashier can only manage employees under the selected manager's zone/department. Each manager can only have one cashier. (Disabled when location is selected)</p>
                       </div>
                     </div>
                   )}

                   {formData.role === "engineer" && (
                     <div className="space-y-3 md:col-span-2 border-t pt-4 mt-2">
                       <Label htmlFor="locations" className="text-sm font-medium text-gray-700 whitespace-nowrap flex items-center gap-2">
                         <MapPin className="h-4 w-4 text-blue-600" />
                         Assign Location
                       </Label>
                       <div className="border rounded-lg p-3 sm:p-4 space-y-2 sm:space-y-3 max-h-40 sm:max-h-48 overflow-y-auto bg-gray-50">
                         {locations.length === 0 ? (
                           <p className="text-xs sm:text-sm text-gray-500 whitespace-nowrap">No locations available. Create locations in Settings first.</p>
                         ) : (
                           <RadioGroup
                             value={formData.locationId || "none"}
                             onValueChange={(value) => setFormData(prev => ({ ...prev, locationId: value }))}
                           >
                             <div key="none" className="flex items-center space-x-2">
                               <RadioGroupItem value="none" id="location-none" />
                               <label
                                 htmlFor="location-none"
                                 className="text-xs sm:text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                               >
                                 <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-500 flex-shrink-0" />
                                 <span className="truncate">Unassigned</span>
                               </label>
                             </div>
                             {locations.map((location) => (
                               <div key={location.id} className="flex items-center space-x-2">
                                 <RadioGroupItem value={location.id} id={`location-${location.id}`} />
                                 <label
                                   htmlFor={`location-${location.id}`}
                                   className="text-xs sm:text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex items-center gap-2 whitespace-nowrap"
                                 >
                                   <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-500 flex-shrink-0" />
                                   <span className="truncate">{location.name}</span>
                                 </label>
                               </div>
                             ))}
                           </RadioGroup>
                         )}
                       </div>
                       <p className="text-xs text-gray-500 whitespace-nowrap">Select one location for this manager. Each manager can only be assigned to one location.</p>
                     </div>
                   )}

                  <div className="space-y-3">
                    <Label htmlFor="password" className="text-sm font-medium text-gray-700">Permanent Password *</Label>
                    <div className="flex gap-3">
                      <div className="relative flex-1 group">
                        <Input
                          id="password"
                          type={showPassword ? "text" : "password"}
                          value={formData.password}
                          onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                          placeholder="Enter permanent password (min 8 characters)"
                          className={`h-12 pr-20 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 transition-colors duration-150 ${
                            formData.password && formData.password.length < 8 ? "border-red-300 focus:border-red-500" : ""
                          }`}
                          required
                        />
                        <div className="absolute right-3 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
                          {formData.password && formData.password.length >= 8 && (
                            <CheckCircle className="h-4 w-4 text-green-500" />
                          )}
                          {formData.password && (
                            <button
                              type="button"
                              onClick={() => setShowPassword(!showPassword)}
                              className="text-gray-400 hover:text-gray-600 transition-colors focus:outline-none"
                              aria-label={showPassword ? "Hide password" : "Show password"}
                            >
                              {showPassword ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                      <Button
                        type="button"
                        onClick={generatePassword}
                        className="h-12 px-6 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-medium shadow-lg transition-colors duration-150"
                      >
                        <Sparkles className="h-4 w-4 mr-2" />
                        Generate
                      </Button>
                    </div>
                    {formData.password && formData.password.length < 8 && (
                      <p className="text-xs text-red-500 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        Password must be at least 8 characters long
                      </p>
                    )}
                    <p className="text-xs text-gray-500">
                      This password will be the user's final password
                    </p>
                  </div>
                </div>
              </div>

              {/* Information Cards */}
              <div className="grid gap-6 md:grid-cols-2">
                <div className="bg-gradient-to-br from-blue-50 to-indigo-50 p-6 rounded-xl border border-blue-200">
                  <h4 className="font-semibold text-blue-900 mb-3 flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    Role Permissions
                  </h4>
                  <div className="space-y-2 text-sm text-blue-800">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                      <span><strong>Employee:</strong> Create and submit expense claims</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                      <span><strong>Manager:</strong> Review and verify assigned expenses</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                      <span><strong>Admin:</strong> Full system access and user management</span>
                    </div>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-emerald-50 to-green-50 p-6 rounded-xl border border-emerald-200">
                  <h4 className="font-semibold text-emerald-900 mb-3 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4" />
                    Account Creation Process
                  </h4>
                  <div className="space-y-2 text-sm text-emerald-800">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                      <span>Password must be at least 8 characters</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                      <span>Account is created and activated immediately</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                      <span>User can sign in right away</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Submit Button */}
              <div className="pt-4">
                <Button 
                  type="submit" 
                  className="w-full h-14 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold text-lg shadow-xl hover:shadow-xl transition-colors duration-200"
                  disabled={loading}
                >
                  {loading ? (
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                      Creating User...
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <UserPlus className="h-5 w-5" />
                      Create User Account
                    </div>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Guidelines Card */}
        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardHeader className="bg-gradient-to-r from-gray-50 to-slate-50 p-6">
            <CardTitle className="text-xl font-bold text-gray-900 flex items-center gap-2">
              <Settings className="h-5 w-5 text-gray-600" />
              User Creation Guidelines
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-4">
                <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-600" />
                  Security Requirements
                </h4>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mt-2"></div>
                    <span>Passwords must be at least 8 characters long</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mt-2"></div>
                    <span>Email addresses must be unique and valid</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-blue-500 rounded-full mt-2"></div>
                    <span>Only administrators can create user accounts</span>
                  </li>
                </ul>
              </div>
              
              <div className="space-y-4">
                <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-green-600" />
                  Account Management
                </h4>
                <ul className="space-y-2 text-sm text-gray-600">
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full mt-2"></div>
                    <span>User roles can be modified after account creation</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full mt-2"></div>
                    <span>Accounts can be deactivated if needed</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <div className="w-1.5 h-1.5 bg-green-500 rounded-full mt-2"></div>
                    <span>All user actions are logged for audit purposes</span>
                  </li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      </>}
      {/* Details Drawer */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl md:max-w-2xl lg:max-w-3xl overflow-y-auto">
          <SheetHeader className="relative pr-20">
            <div className="absolute right-12 top-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (selectedUser) {
                    openEditDialog(selectedUser);
                    setDrawerOpen(false);
                  }
                }}
                className="flex items-center gap-2"
              >
                <Edit className="h-4 w-4" />
                Edit
              </Button>
            </div>
            <SheetTitle>User Details</SheetTitle>
            <SheetDescription>Profile, balance, and complete expense history</SheetDescription>
          </SheetHeader>
          {selectedUser && (
            <div className="space-y-6 py-4">
              <div>
                <div className="text-lg font-semibold">{selectedUser.name}</div>
                <div className="text-slate-600 text-sm">{selectedUser.email}</div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <RoleBadgeWithLabels role={selectedUser.role} size="md" />
                <Separator orientation="vertical" className="h-5" />
                <div className="text-sm">Balance: <span className="font-semibold">{formatINR(Number(selectedUser.balance ?? 0))}</span></div>
              </div>

              <Separator />

              <div>
                <div className="text-base font-semibold mb-3">Expenses</div>
                {expensesLoading ? (
                  <div className="text-sm text-slate-600">Loading expenses...</div>
                ) : expenses.length === 0 ? (
                  <div className="text-sm text-slate-600">{t("admin:users.noExpenses")}</div>
                ) : (
                  <div className="space-y-3">
                    {expenses.map((e) => (
                      <div key={e.id} className="p-3 rounded border bg-white">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{e.title || "Untitled"}</div>
                          <div className="text-sm">{formatINR(Number(e.total_amount ?? 0))}</div>
                        </div>
                        <div className="flex items-center justify-between text-xs text-slate-600 mt-1">
                          <div>Category: {e.category || "-"}</div>
                          <div>Status: {e.status}</div>
                        </div>
                        <div className="text-xs text-slate-500 mt-1">
                          Created: {new Date(e.created_at).toLocaleString()} {e.updated_at ? `• Updated: ${new Date(e.updated_at).toLocaleString()}` : ""}
                        </div>

                        {/* History timeline */}
                        {logsByExpense[e.id] && logsByExpense[e.id].length > 0 && (
                          <div className="mt-3 border-t pt-2 space-y-1">
                            {logsByExpense[e.id].map((log) => (
                              <div key={log.created_at + log.action} className="text-xs flex items-center justify-between">
                                <div className="text-slate-600">{log.action.replaceAll("_", " ")}</div>
                                <div className="text-slate-500">{new Date(log.created_at).toLocaleString()}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Balance deductions (from approvals) */}
              <div>
                <div className="text-base font-semibold mb-3">Balance Deductions</div>
                {deductions.length === 0 ? (
                  <div className="text-sm text-slate-600">No deductions recorded</div>
                ) : (
                  <div className="space-y-2">
                    {deductions.map((d) => (
                      <div key={d.expense_id + d.at} className="p-3 rounded border bg-white text-sm">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{d.title}</div>
                          <div className="font-semibold">-{formatINR(Number(d.amount ?? 0))}</div>
                        </div>
                        <div className="text-xs text-slate-500">{new Date(d.at).toLocaleString()}</div>
                        {d.comment ? (
                          <div className="text-xs text-slate-600 mt-1">{d.comment}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] sm:max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="flex-shrink-0">
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>Update user information and role</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4 overflow-y-auto overflow-x-hidden flex-1 min-h-0">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Name *</Label>
              <Input
                id="edit-name"
                value={editFormData.name}
                onChange={(e) => setEditFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Full name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email *</Label>
              <Input
                id="edit-email"
                type="email"
                value={editFormData.email}
                onChange={(e) => setEditFormData(prev => ({ ...prev, email: e.target.value }))}
                placeholder="email@example.com"
              />
            </div>
            {showEmployeeIdField ? (
              <div className="space-y-2">
                <Label htmlFor="edit-employee-id">Employee ID</Label>
                <Input
                  id="edit-employee-id"
                  type="text"
                  value={editFormData.employee_id}
                  onChange={(e) =>
                    setEditFormData((prev) => ({ ...prev, employee_id: e.target.value }))
                  }
                  placeholder="Employee ID"
                  className="font-mono"
                />
              </div>
            ) : null}
            {/* Password Reset Section - Only for non-admin users */}
            {userToEdit && userToEdit.role !== "admin" && (
              <div className="space-y-2 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Label>Reset Password</Label>
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  Reset this user's password. You'll need to enter your admin password to confirm.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setResetPasswordDialogOpen(true);
                    setAdminPassword("");
                    setNewUserPassword("");
                  }}
                  className="w-full"
                >
                  <Lock className="h-4 w-4 mr-2 flex-shrink-0" />
                  Reset Password
                </Button>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role *</Label>
              <Select
                value={editFormData.role}
                onValueChange={(value: OrgRole) =>
                  setEditFormData((prev) => ({ ...prev, role: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <RoleSelectItems
                    teamLeaderTierEnabled={teamLeaderTierEnabled}
                    executiveTierEnabled={executiveTierEnabled}
                  />
                </SelectContent>
              </Select>
            </div>
            {userRole === "admin" && (
              <div className="space-y-2">
                <Label htmlFor="edit-balance">Balance (INR)</Label>
                <div className="flex gap-2">
                  <Input
                    id="edit-balance"
                    type="number"
                    step="0.01"
                    value={editFormData.balance ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? 0 : parseFloat(e.target.value);
                      setEditFormData(prev => ({ ...prev, balance: Number.isNaN(v) ? 0 : v }));
                    }}
                    placeholder="0"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditFormData(prev => ({ ...prev, balance: 0 }))}
                  >
                    Set to 0
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Edit or clear this user&apos;s balance. Use 0 to remove.</p>
              </div>
            )}
            {roleShowsImmediateSupervisor(editFormData.role) && (
              <div className="space-y-2">
                <Label htmlFor="edit-engineer">
                  {immediateSupervisorFieldLabel(editFormData.role)}
                  {isImmediateSupervisorRequired(editFormData.role, requireImmediateSupervisor) ? " *" : ""}
                </Label>
                <Select
                  value={editFormData.reportingEngineerId}
                  onValueChange={(value) => setEditFormData(prev => ({ ...prev, reportingEngineerId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select supervisor" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {editSupervisorOptions.map((supervisor) => (
                      <SelectItem key={supervisor.user_id} value={supervisor.user_id}>
                        {supervisor.name} ({getRoleLabel(supervisor.role)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {immediateSupervisorFieldHint(editFormData.role)}
                </p>
              </div>
            )}
            {editFormData.role === "employee" && teamsEnabled && teams.length > 0 && (
              <div className="space-y-2">
                <Label htmlFor="edit-team">Team</Label>
                <Select
                  value={editFormData.teamId || "none"}
                  onValueChange={(value) => setEditFormData((prev) => ({ ...prev, teamId: value }))}
                >
                  <SelectTrigger id="edit-team">
                    <SelectValue placeholder="Select team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No team</SelectItem>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {editFormData.role === "employee" && (
              <div className="space-y-2">
                <Label htmlFor="edit-cashier">Assign Cashier</Label>
                <Select
                  value={editFormData.assignedCashierId}
                  onValueChange={(value) => setEditFormData(prev => ({ ...prev, assignedCashierId: value }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select cashier" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {cashiers.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} ({c.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Employee will return money to this cashier.</p>
              </div>
            )}
            {editFormData.role === "engineer" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-engineer-cashier">Assign Cashier</Label>
                  <Select
                    value={editFormData.assignedCashierId}
                    onValueChange={(value) => setEditFormData(prev => ({ ...prev, assignedCashierId: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select cashier" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {cashiers.map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} ({c.email})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Manager will return money to this cashier.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-locations">Assign Location</Label>
                  <div className="border rounded-lg p-3 sm:p-4 space-y-2 sm:space-y-3 max-h-40 sm:max-h-48 overflow-y-auto overflow-x-hidden">
                    {locations.length === 0 ? (
                      <p className="text-xs sm:text-sm text-gray-500">No locations available. Create locations in Settings first.</p>
                    ) : (
                      <RadioGroup
                        value={editFormData.locationId || "none"}
                        onValueChange={(value) => setEditFormData(prev => ({ ...prev, locationId: value }))}
                      >
                        <div key="none" className="flex items-center space-x-2">
                          <RadioGroupItem value="none" id="edit-location-none" />
                          <label
                            htmlFor="edit-location-none"
                            className="text-xs sm:text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex items-center gap-2 min-w-0"
                          >
                            <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-500 flex-shrink-0" />
                            <span className="truncate">Unassigned</span>
                          </label>
                        </div>
                        {locations.map((location) => (
                          <div key={location.id} className="flex items-center space-x-2">
                            <RadioGroupItem value={location.id} id={`edit-location-${location.id}`} />
                            <label
                              htmlFor={`edit-location-${location.id}`}
                              className="text-xs sm:text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer flex items-center gap-2 min-w-0"
                            >
                              <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-500 flex-shrink-0" />
                              <span className="truncate">{location.name}</span>
                            </label>
                          </div>
                        ))}
                      </RadioGroup>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">Select one location for this manager. Each manager can only be assigned to one location.</p>
                </div>
              </>
            )}
            {editFormData.role === "cashier" && cashierAccountantModeEnabled && (
              <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="edit-accountant-cashier"
                    checked={editFormData.isAccountantCashier}
                    onCheckedChange={(checked) =>
                      setEditFormData((prev) => ({
                        ...prev,
                        isAccountantCashier: checked === true,
                      }))
                    }
                  />
                  <div className="space-y-1">
                    <Label htmlFor="edit-accountant-cashier" className="cursor-pointer">
                      {t("cashier:userManagement.accountantCashierLabel")}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t("cashier:userManagement.accountantCashierHint")}
                    </p>
                  </div>
                </div>
              </div>
            )}
            {editFormData.role === "cashier" && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="edit-cashier-location" className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-blue-600" />
                    Assign Location (Recommended)
                  </Label>
                  <Select
                    value={editFormData.cashierAssignedLocationId || "none"}
                    onValueChange={(value) => setEditFormData(prev => ({ ...prev, cashierAssignedLocationId: value, cashierAssignedEngineerId: "none" }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select location" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned</SelectItem>
                      {locations.map(loc => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-gray-500">If set, this cashier will manage all managers and employees in this location.</p>
                </div>
                
                <div className="space-y-2 border-t pt-3">
                  <Label htmlFor="edit-cashier-engineer">OR Assign Manager Directly (Fallback)</Label>
                  <Select
                    value={editFormData.cashierAssignedEngineerId}
                    onValueChange={(value) => setEditFormData(prev => ({ ...prev, cashierAssignedEngineerId: value, cashierAssignedLocationId: "none" }))}
                    disabled={editFormData.cashierAssignedLocationId && editFormData.cashierAssignedLocationId !== "none"}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select manager" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Unassigned (Can manage all)</SelectItem>
                      {engineers.filter(e => {
                        // Filter out engineers who already have a cashier (unless editing the current cashier)
                        const engineerHasCashier = users.some(u => 
                          u.role === "cashier" && 
                          u.user_id !== userToEdit?.user_id && // Exclude current cashier being edited
                          u.cashier_assigned_engineer_name &&
                          // Find the engineer user by matching name
                          users.find(eng => eng.role === "engineer" && eng.name === u.cashier_assigned_engineer_name)?.user_id === e.id
                        );
                      return !engineerHasCashier;
                    }).map(e => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name} ({e.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">If set, this cashier can only manage employees under the selected manager's zone/department. Each manager can only have one cashier. (Disabled when location is selected)</p>
              </div>
            </div>
            )}
          </div>
          <DialogFooter className="flex-shrink-0 border-t pt-4 mt-4">
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleUpdateUser} disabled={updating}>
              {updating ? "Updating..." : "Update User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deactivate User Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {userToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Deactivating this user prevents future access while preserving their expenses,
                  approvals, audit history, attachments, and other historical records.
                </p>
                <p>
                  {userToDelete?.name} ({userToDelete?.email}) will no longer be able to sign in.
                  Nothing is deleted, and you can reactivate this account at any time.
                </p>
                {deactivationImpactLoading ? (
                  <p className="text-xs text-muted-foreground italic">Checking current responsibilities…</p>
                ) : deactivationImpact ? (
                  deactivationImpact.is_only_active_admin ? (
                    <p className="text-sm font-medium text-red-700" data-testid="deactivation-blocked-only-admin">
                      This user is the organization&apos;s only active administrator. Assign another admin before deactivating this account.
                    </p>
                  ) : (deactivationImpact.reports_count > 0 || deactivationImpact.pending_reviews_assigned > 0 || deactivationImpact.pending_expense_assignments > 0) ? (
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800" data-testid="deactivation-impact-warning">
                      <p className="font-medium mb-1">This person currently has:</p>
                      <ul className="list-disc list-inside space-y-0.5">
                        {deactivationImpact.reports_count > 0 ? <li>{deactivationImpact.reports_count} employee{deactivationImpact.reports_count === 1 ? "" : "s"} reporting to them</li> : null}
                        {deactivationImpact.pending_reviews_assigned > 0 ? <li>{deactivationImpact.pending_reviews_assigned} pending review{deactivationImpact.pending_reviews_assigned === 1 ? "" : "s"} assigned</li> : null}
                        {deactivationImpact.pending_expense_assignments > 0 ? <li>{deactivationImpact.pending_expense_assignments} pending expense assignment{deactivationImpact.pending_expense_assignments === 1 ? "" : "s"}</li> : null}
                      </ul>
                      <p className="mt-1">Consider reassigning these before deactivating, or reassign afterward from each item.</p>
                    </div>
                  ) : null
                ) : null}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteUser}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleting || deactivationImpactLoading || deactivationImpact?.is_only_active_admin === true}
            >
              {deleting ? "Deactivating..." : "Deactivate User"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Password Dialog */}
      <Dialog open={resetPasswordDialogOpen} onOpenChange={setResetPasswordDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset User Password</DialogTitle>
            <DialogDescription>
              Reset password for {userToEdit?.name} ({userToEdit?.email})
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="admin-password">Your Admin Password *</Label>
              <div className="relative">
                <Input
                  id="admin-password"
                  type={showAdminPassword ? "text" : "password"}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Enter your admin password"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowAdminPassword(!showAdminPassword)}
                >
                  {showAdminPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Enter your admin password to confirm this action
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password *</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  type={showNewPassword ? "text" : "password"}
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Enter new password (min 8 characters)"
                  minLength={8}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowNewPassword(!showNewPassword)}
                >
                  {showNewPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum 8 characters required
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setResetPasswordDialogOpen(false);
              setAdminPassword("");
              setNewUserPassword("");
            }}>
              Cancel
            </Button>
            <Button 
              onClick={handleResetPassword}
              disabled={!adminPassword || !newUserPassword || newUserPassword.length < 8 || resettingPassword}
            >
              {resettingPassword ? "Verifying..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset Password Confirmation Dialog */}
      <AlertDialog open={resetPasswordConfirmOpen} onOpenChange={setResetPasswordConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Password Reset</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to reset the password for <strong>{userToEdit?.name}</strong> ({userToEdit?.email})?
              <br /><br />
              The new password will be: <strong>{newUserPassword}</strong>
              <br /><br />
              This action cannot be undone. The user will need to use this new password to log in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => {
              setResetPasswordConfirmOpen(false);
              setAdminPassword("");
              setNewUserPassword("");
            }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmResetPassword}
              className="bg-blue-600 hover:bg-blue-700"
              disabled={resettingPassword}
            >
              {resettingPassword ? "Resetting..." : "Confirm Reset"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Password Success Dialog */}
      <Dialog open={resetPasswordSuccessOpen} onOpenChange={setResetPasswordSuccessOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5 text-green-600" />
              Password Reset Successful
            </DialogTitle>
            <DialogDescription>
              The password has been reset for {userToEdit?.name}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>New Password</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={resetPasswordValue}
                  readOnly
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={copyPassword}
                  className="flex-shrink-0"
                >
                  {passwordCopied ? (
                    <>
                      <Check className="h-4 w-4 mr-2" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4 mr-2" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Please copy this password and share it securely with the user. They will need it to log in.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => {
              setResetPasswordSuccessOpen(false);
              setResetPasswordValue("");
            }}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}