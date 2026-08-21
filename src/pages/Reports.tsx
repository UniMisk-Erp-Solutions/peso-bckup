import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { ReportLiveRefreshBar } from "@/components/ReportLiveRefreshBar";
import { reportKeys } from "@/lib/reportQueryKeys";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/auth-context";
import { useCashierCapabilities } from "@/hooks/useCashierCapabilities";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import {
  DAILY_PROJECT_REPORT_HEADERS,
  fetchOrganizationDailyReportConfig,
  isDailyReportConfigReady,
  isDailyReportRowNeedsReview,
  type DailyExpenseReportConfig,
  type DailyProjectExpenseReportRow,
} from "@/lib/dailyExpenseReportConfig";
import { dailyReportResultsToRows, type DailyProjectExpenseReportBuildResult } from "@/lib/buildDailyProjectExpenseReport";
import {
  runDailyProjectReportExport,
  DailyReportExportError,
  type DailyReportExportProgress,
} from "@/lib/dailyProjectReportPaging";
import { downloadDailyProjectExpenseReportFile } from "@/lib/exportDailyProjectExpenseReport";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatINR } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { Eye, FileText, FileSpreadsheet, FileJson, FileType, Printer } from "lucide-react";
import { useNavigate } from "react-router-dom";
import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { fetchOrganizationUsers } from "@/lib/orgUsers";
import { fetchExpenseSubmitterProfiles } from "@/lib/supabaseInQuery";
import {
  CUSTOM_FIELD_FILTER_ALL,
  fetchExpenseCustomFieldsMap,
  fetchFilledCustomFieldValuesForEmployee,
  fetchFilledCustomFieldValuesForOrganization,
  filterExpensesByCustomFields,
  isCustomFieldChoiceFilled,
  mergeFilterableFieldsWithEmployeeData,
} from "@/lib/expenseCustomFieldFilters";
import { useExpenseCustomFieldFilters } from "@/hooks/useExpenseCustomFieldFilters";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import { DailyReportSourceExpensesSheet } from "@/components/DailyReportSourceExpensesSheet";
import { hasApprovalHierarchy, hasTeamsEnabled } from "@/lib/orgFeatureGates";
import {
  fetchTeamMemberUserIds,
  fetchTeamScopedExpenses,
  TEAM_REPORTS_LEADER_ROLES,
} from "@/lib/teamReportsScope";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileDetailedExpenseReportView } from "@/components/mobile/MobileDetailedExpenseReportView";

export type ReportsProps = {
  /** When true, only expenses for My Teams members are shown. */
  teamScoped?: boolean;
};

function chunkIds<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchSubmitterProfiles(
  organizationId: string,
  userIds: string[],
): Promise<{ user_id: string; name: string; email: string }[]> {
  if (userIds.length === 0) return [];
  return fetchExpenseSubmitterProfiles(supabase, organizationId, userIds);
}

/** Legacy DBs use `active` on categories; newer use `is_active`. PostgREST often returns 400, not 42703. */
function isSchemaMismatchError(error: unknown): boolean {
  const e = error as { code?: string; message?: string; status?: number };
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204") return true;
  const msg = String(e.message ?? "").toLowerCase();
  if (msg.includes("does not exist") || msg.includes("could not find")) return true;
  return e.status === 400;
}

/** Pending verified claims are not deducted from wallet yet: forward from balance + sum(amounts in this export). */
function computeRowBalancesForVerification(
  expenses: { id: string; user_id: string; trip_start: string; created_at: string; total_amount: number | null }[],
  userBalances: Record<string, number>
): Map<string, { opening: number; closing: number }> {
  type Row = (typeof expenses)[number];
  const byUser = new Map<string, Row[]>();
  for (const e of expenses) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id)!.push(e);
  }
  const result = new Map<string, { opening: number; closing: number }>();
  for (const [uid, list] of byUser) {
    const sorted = [...list].sort((a, b) => {
      const d = new Date(a.trip_start).getTime() - new Date(b.trip_start).getTime();
      if (d !== 0) return d;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    const total = sorted.reduce((s, e) => s + Number(e.total_amount || 0), 0);
    let run = (userBalances[uid] ?? 0) + total;
    for (const e of sorted) {
      const amt = Number(e.total_amount || 0);
      const opening = run;
      const closing = run - amt;
      result.set(e.id, { opening, closing });
      run = closing;
    }
  }
  return result;
}

/** Approved amounts are reflected in current balance: walk backward from profile balance. */
function computeRowBalancesForApproval(
  expenses: { id: string; user_id: string; trip_start: string; created_at: string; total_amount: number | null }[],
  userBalances: Record<string, number>
): Map<string, { opening: number; closing: number }> {
  type Row = (typeof expenses)[number];
  const byUser = new Map<string, Row[]>();
  for (const e of expenses) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id)!.push(e);
  }
  const result = new Map<string, { opening: number; closing: number }>();
  for (const [uid, list] of byUser) {
    const sorted = [...list].sort((a, b) => {
      const d = new Date(a.trip_start).getTime() - new Date(b.trip_start).getTime();
      if (d !== 0) return d;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    let run = userBalances[uid] ?? 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const e = sorted[i];
      const amt = Number(e.total_amount || 0);
      const closing = run;
      const opening = run + amt;
      result.set(e.id, { opening, closing });
      run = opening;
    }
  }
  return result;
}

function sortedCustomFieldKeys(rows: { custom_fields?: Record<string, string> }[]): string[] {
  const keys = new Set<string>();
  rows.forEach((r) => {
    Object.keys(r.custom_fields || {}).forEach((k) => keys.add(k));
  });
  return [...keys].sort((a, b) => a.localeCompare(b));
}

interface ExpenseWithUser {
  id: string;
  user_id: string;
  title: string | null;
  total_amount: number | null;
  status: string | null;
  created_at: string;
  trip_start: string;
  trip_end: string;
  category: string | null;
  purpose?: string | null;
  destination?: string | null;
  transaction_number?: string | null;
  batch_id?: string | null;
  user_name: string;
  user_email: string;
  employee_id: string;
  custom_fields?: Record<string, string>;
  /** Batch label / shared category / short id for batch-submitted lines; "-" for standalone. */
  batch_ref: string;
}

/** Label shown in reports for batch-submitted expenses (same column for standalone vs batch). */
function formatReportBatchRef(
  batchId: string | null | undefined,
  label: string | null | undefined,
  sharedCategory: string | null | undefined,
): string {
  if (!batchId) return "-";
  const l = (label || "").trim();
  if (l) return l;
  const c = (sharedCategory || "").trim();
  if (c) return c;
  return `Batch ${batchId.slice(0, 8)}…`;
}

async function mapExpensesWithUsersAndBatch<
  T extends {
    id: string;
    user_id: string;
    batch_id?: string | null;
    title: string | null;
    total_amount: number | null;
    status: string | null;
    created_at: string;
    trip_start: string;
    trip_end: string;
    category: string | null;
    purpose?: string | null;
    destination?: string | null;
    transaction_number?: string | null;
  },
>(
  rows: T[],
  profiles: { user_id: string; name: string | null; email: string | null; employee_id?: string | null }[] | null,
  customByExpense: Record<string, Record<string, string>>,
): Promise<ExpenseWithUser[]> {
  const batchIds = [...new Set(rows.map((r) => r.batch_id).filter(Boolean))] as string[];
  const metaById: Record<string, { label: string | null; shared_category: string | null }> = {};
  if (batchIds.length > 0) {
    const { data, error } = await supabase
      .from("expense_batches")
      .select("id, label, shared_category")
      .in("id", batchIds);
    if (error) {
      console.warn("expense_batches (reports)", error);
    } else {
      for (const b of data || []) {
        const row = b as { id: string; label: string | null; shared_category: string | null };
        metaById[row.id] = { label: row.label ?? null, shared_category: row.shared_category ?? null };
      }
    }
  }
  return rows.map((expense) => {
    const profile = profiles?.find((p) => p.user_id === expense.user_id);
    const bm = expense.batch_id ? metaById[expense.batch_id] : undefined;
    return {
      ...expense,
      user_name: profile?.name || "Unknown User",
      user_email: profile?.email || "",
      employee_id: profile?.employee_id || "",
      custom_fields: customByExpense[expense.id] ?? {},
      batch_ref: formatReportBatchRef(expense.batch_id, bm?.label ?? null, bm?.shared_category ?? null),
    } as ExpenseWithUser;
  });
}

interface UserRow {
  user_id: string;
  name: string;
  email: string;
  employee_id?: string | null;
  balance: number;
  role: string;
}

function formatReportUserLabel(user: UserRow): string {
  const name = (user.name || "").trim();
  if (name) return name;
  const email = (user.email || "").trim();
  if (email) return email;
  const eid = (user.employee_id || "").trim();
  if (eid) return eid;
  return user.user_id;
}

interface AllocationRecord {
  id: string;
  transferred_at: string;
  amount: number;
  transfer_type: string;
  notes: string | null;
  transferrer_id: string;
  transferrer_role: string;
  recipient_id: string;
  recipient_role: string;
}

function defaultDailyDateFrom(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function defaultDailyDateTo(): string {
  return new Date().toISOString().slice(0, 10);
}

type DailyPeriodMode = "custom" | "all_time";

// ─────────────────────────────────────────────────────────────────────────────
// Pure async loaders — return complete data, never mutate React state.
// Used as React Query queryFn so errors keep previous cached data visible.
// ─────────────────────────────────────────────────────────────────────────────

interface VerificationParams {
  organizationId: string;
  teamScoped: boolean;
  teamMemberUserIds: string[];
  selectedEmployee: string;
  selectedCategory: string;
  engineerStatus: string;
}

async function loadVerificationReport(p: VerificationParams): Promise<ExpenseWithUser[]> {
  const { organizationId, teamScoped, teamMemberUserIds, selectedEmployee, selectedCategory, engineerStatus } = p;
  const statusValues: string[] =
    engineerStatus === "all"
      ? ["verified", "level_1_verified", "level_2_verified"]
      : [engineerStatus];

  const data = await fetchTeamScopedExpenses({
    teamScoped,
    teamUserIds: teamMemberUserIds,
    selectedEmployee,
    sortBy: "created_at",
    rpcOptions: teamScoped
      ? {
          supabase,
          organizationId,
          statuses: statusValues,
          category: selectedCategory !== "all" ? selectedCategory : undefined,
        }
      : undefined,
    buildQuery: (applyUserFilter) => {
      let q = applyUserFilter(
        supabase
          .from("expenses")
          .select("id, user_id, title, total_amount, status, created_at, trip_start, trip_end, category, purpose, destination, transaction_number, batch_id")
          .eq("organization_id", organizationId)
          .in("status", statusValues),
      );
      if (selectedCategory !== "all") q = q.ilike("category", selectedCategory);
      return q.order("created_at", { ascending: false });
    },
  });

  if (!data || data.length === 0) return [];
  const userIds = [...new Set(data.map((e) => e.user_id as string))];
  const [profiles, customByExpense] = await Promise.all([
    fetchSubmitterProfiles(organizationId, userIds),
    fetchExpenseCustomFieldsMap(organizationId, data.map((e) => e.id as string)),
  ]);
  return mapExpensesWithUsersAndBatch(data, profiles, customByExpense);
}

interface ApprovalParams {
  organizationId: string;
  teamScoped: boolean;
  teamMemberUserIds: string[];
  selectedEmployee: string;
  selectedCategory: string;
  engineerStatus: string;
}

async function loadApprovalReport(p: ApprovalParams): Promise<ExpenseWithUser[]> {
  const { organizationId, teamScoped, teamMemberUserIds, selectedEmployee, selectedCategory } = p;

  const data = await fetchTeamScopedExpenses({
    teamScoped,
    teamUserIds: teamMemberUserIds,
    selectedEmployee,
    sortBy: "created_at",
    rpcOptions: teamScoped
      ? {
          supabase,
          organizationId,
          statuses: ["approved"],
          category: selectedCategory !== "all" ? selectedCategory : undefined,
        }
      : undefined,
    buildQuery: (applyUserFilter) => {
      let q = applyUserFilter(
        supabase
          .from("expenses")
          .select("id, user_id, title, total_amount, status, created_at, trip_start, trip_end, category, purpose, destination, transaction_number, batch_id")
          .eq("organization_id", organizationId)
          .eq("status", "approved"),
      );
      if (selectedCategory !== "all") q = q.ilike("category", selectedCategory);
      return q.order("created_at", { ascending: false });
    },
  });

  if (!data || data.length === 0) return [];
  const userIds = [...new Set(data.map((e) => e.user_id as string))];
  const [profiles, customByExpense] = await Promise.all([
    fetchSubmitterProfiles(organizationId, userIds),
    fetchExpenseCustomFieldsMap(organizationId, data.map((e) => e.id as string)),
  ]);
  return mapExpensesWithUsersAndBatch(data, profiles, customByExpense);
}

interface DetailedParams {
  organizationId: string;
  teamScoped: boolean;
  teamMemberUserIds: string[];
  selectedEmployee: string;
  selectedCategory: string;
  selectedYear: string;
  selectedMonth: string;
}

interface DetailedResult {
  expenses: ExpenseWithUser[];
  allocations: AllocationRecord[];
}

async function loadDetailedReport(p: DetailedParams): Promise<DetailedResult> {
  const { organizationId, teamScoped, teamMemberUserIds, selectedEmployee, selectedCategory, selectedYear, selectedMonth } = p;

  let detailedTripFrom: string | undefined;
  let detailedTripTo: string | undefined;
  if (selectedYear && selectedMonth !== "all") {
    const monthNum = parseInt(selectedMonth, 10);
    detailedTripFrom = new Date(parseInt(selectedYear, 10), monthNum - 1, 1).toISOString().split("T")[0];
    detailedTripTo = new Date(parseInt(selectedYear, 10), monthNum, 0).toISOString().split("T")[0];
  } else if (selectedYear) {
    detailedTripFrom = `${selectedYear}-01-01`;
    detailedTripTo = `${selectedYear}-12-31`;
  }

  const data = await fetchTeamScopedExpenses({
    teamScoped,
    teamUserIds: teamMemberUserIds,
    selectedEmployee,
    sortBy: "trip_start",
    rpcOptions: teamScoped
      ? {
          supabase,
          organizationId,
          statuses: ["approved"],
          category: selectedCategory !== "all" ? selectedCategory : undefined,
          tripStartFrom: detailedTripFrom,
          tripStartTo: detailedTripTo,
        }
      : undefined,
    buildQuery: (applyUserFilter) => {
      let q = applyUserFilter(
        supabase
          .from("expenses")
          .select("id, user_id, title, total_amount, status, created_at, trip_start, trip_end, category, purpose, destination, batch_id, transaction_number")
          .eq("organization_id", organizationId)
          .eq("status", "approved"),
      );
      if (selectedCategory !== "all") q = q.ilike("category", selectedCategory);
      if (selectedYear) {
        q = q
          .gte("trip_start", `${selectedYear}-01-01`)
          .lte("trip_start", `${selectedYear}-12-31`);
      }
      if (selectedMonth !== "all" && selectedYear) {
        const mn = parseInt(selectedMonth, 10);
        const ms = new Date(parseInt(selectedYear, 10), mn - 1, 1);
        const me = new Date(parseInt(selectedYear, 10), mn, 0);
        q = q
          .gte("trip_start", ms.toISOString().split("T")[0])
          .lte("trip_start", me.toISOString().split("T")[0]);
      }
      return q.order("trip_start", { ascending: false });
    },
  });

  let expenses: ExpenseWithUser[] = [];
  if (data && data.length > 0) {
    const userIds = [...new Set(data.map((e) => e.user_id as string))];
    const [profiles, customByExpense] = await Promise.all([
      fetchSubmitterProfiles(organizationId, userIds),
      fetchExpenseCustomFieldsMap(organizationId, data.map((e) => e.id as string)),
    ]);
    expenses = await mapExpensesWithUsersAndBatch(data, profiles, customByExpense);
  }

  let allocations: AllocationRecord[] = [];
  if (selectedEmployee !== "all") {
    try {
      let q = supabase
        .from("cash_transfer_history")
        .select("id, transferred_at, amount, transfer_type, notes, transferrer_id, transferrer_role, recipient_id, recipient_role")
        .or(`recipient_id.eq.${selectedEmployee},transferrer_id.eq.${selectedEmployee}`)
        .order("transferred_at", { ascending: true });

      if (selectedYear) {
        q = q
          .gte("transferred_at", new Date(`${selectedYear}-01-01T00:00:00.000Z`).toISOString())
          .lte("transferred_at", new Date(`${selectedYear}-12-31T23:59:59.999Z`).toISOString());
      }
      if (selectedMonth !== "all" && selectedYear) {
        const mn = parseInt(selectedMonth, 10);
        const ms = new Date(parseInt(selectedYear, 10), mn - 1, 1);
        const me = new Date(parseInt(selectedYear, 10), mn, 0, 23, 59, 59, 999);
        q = q
          .gte("transferred_at", ms.toISOString())
          .lte("transferred_at", me.toISOString());
      }

      const { data: allocData, error } = await q;
      if (!error) {
        allocations = (allocData || []).map((r: any) => ({
          id: r.id,
          transferred_at: r.transferred_at,
          amount: Number(r.amount ?? 0),
          transfer_type: r.transfer_type ?? "",
          notes: r.notes ?? null,
          transferrer_id: r.transferrer_id ?? "",
          transferrer_role: r.transferrer_role ?? "",
          recipient_id: r.recipient_id ?? "",
          recipient_role: r.recipient_role ?? "",
        }));
      }
    } catch (e) {
      console.warn("Failed to fetch allocation history for detailed report", e);
    }
  }

  return { expenses, allocations };
}

interface DailyParams {
  organizationId: string;
  teamScoped: boolean;
  teamMemberUserIds: string[];
  selectedEmployee: string;
  dailyPeriodMode: DailyPeriodMode;
  dailyDateFrom: string;
  dailyDateTo: string;
  signal?: AbortSignal;
  onProgress?: (progress: DailyReportExportProgress) => void;
}

/**
 * DOC-101 — server-paged Daily Project Report retrieval.
 *
 * Previously this called `fetchDailyProjectExpenseReportRows`, which pulled the
 * whole organization's approved expenses in one unbounded PostgREST request
 * (silently capped at 1000 rows) and then issued one custom-field request per
 * 75 expense ids. Now the server returns already-enriched report rows one
 * bounded page at a time, and the coordinator refuses to produce any result
 * unless it has proven it holds every row of the snapshot.
 *
 * The mapping config is no longer passed from the browser: the RPC reads
 * `organization_settings.daily_expense_report_config` itself.
 */
async function loadDailyReport(p: DailyParams): Promise<DailyProjectExpenseReportBuildResult[]> {
  const {
    organizationId, teamScoped, teamMemberUserIds, selectedEmployee,
    dailyPeriodMode, dailyDateFrom, dailyDateTo, signal, onProgress,
  } = p;
  const isAllTime = dailyPeriodMode === "all_time";

  // A team-scoped report with no resolvable members has an empty population;
  // asking the server for `user_id = ANY('{}')` would be a needless round trip.
  if (teamScoped && teamMemberUserIds.length === 0) return [];

  const outcome = await runDailyProjectReportExport({
    organizationId,
    dateFrom: isAllTime ? null : dailyDateFrom,
    dateTo: isAllTime ? null : dailyDateTo,
    userId: selectedEmployee !== "all" ? selectedEmployee : null,
    userIds: teamScoped ? teamMemberUserIds : null,
    teamScoped,
    signal,
    onProgress,
  });
  return outcome.results;
}

export default function Reports({ teamScoped = false }: ReportsProps) {
  const { t } = useTranslation("reports");
  const {
    organizationId,
    hasOrganizationFeature,
    userRole,
    organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
  } = useAuth();
  const { isMobile } = useViewportMode();
  const { canAccessReports } = useCashierCapabilities();
  const featureCtx = {
    featureFlags: organizationFeatureFlags,
    isTenantHost,
    tenantHostOrgId,
    organizationId,
  };
  const myTeamsEnabled =
    hasTeamsEnabled(featureCtx) || hasApprovalHierarchy(featureCtx);
  const canViewTeamReports =
    teamScoped &&
    myTeamsEnabled &&
    Boolean(userRole && TEAM_REPORTS_LEADER_ROLES.has(userRole));
  const canViewReports = teamScoped ? canViewTeamReports : canAccessReports;
  const { toast } = useToast();
  const dailyProjectReportEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.daily_project_expense_report,
  );
  const {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
    resetCustomFieldFilters,
  } = useExpenseCustomFieldFilters(organizationId);
  const [employeeFilledFieldValues, setEmployeeFilledFieldValues] = useState<
    Record<string, string[]>
  >({});
  const [loadingEmployeeFieldOptions, setLoadingEmployeeFieldOptions] = useState(false);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<
    "verification" | "approval" | "detailed" | "daily"
  >("verification");

  // Common filters
  const [selectedEmployee, setSelectedEmployee] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [engineerStatus, setEngineerStatus] = useState<string>("all");
  const [hoStatus, setHoStatus] = useState<string>("approved");

  // Detailed report filters
  const [selectedYear, setSelectedYear] = useState<string>(new Date().getFullYear().toString());
  const [selectedMonth, setSelectedMonth] = useState<string>("all");
  const [selectedWeek, setSelectedWeek] = useState<string>("all");

  const queryClient = useQueryClient();
  const dailyReportConfigRef = useRef<DailyExpenseReportConfig | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportTab, setExportTab] = useState<
    "verification" | "approval" | "detailed" | "daily"
  >("verification");

  const [dailyDateFrom, setDailyDateFrom] = useState(defaultDailyDateFrom);
  const [dailyDateTo, setDailyDateTo] = useState(defaultDailyDateTo);
  const [dailyPeriodMode, setDailyPeriodMode] = useState<DailyPeriodMode>("all_time");
  const [dailyReportSourceOpen, setDailyReportSourceOpen] = useState(false);
  /** Live page progress for the server-paged Daily Project Report (DOC-101). */
  const [dailyProgress, setDailyProgress] = useState<DailyReportExportProgress | null>(null);
  const [selectedDailyReportResult, setSelectedDailyReportResult] =
    useState<DailyProjectExpenseReportBuildResult | null>(null);
  const [dailyReportConfig, setDailyReportConfig] = useState<DailyExpenseReportConfig | null>(null);
  const [dailyConfigReady, setDailyConfigReady] = useState(false);
  const [teamMemberUserIds, setTeamMemberUserIds] = useState<string[]>([]);
  const [teamScopeReady, setTeamScopeReady] = useState(!teamScoped);

  useEffect(() => {
    if (!teamScoped || !organizationId || !canViewTeamReports) {
      setTeamMemberUserIds([]);
      setTeamScopeReady(true);
      return;
    }
    setTeamScopeReady(false);
    void fetchTeamMemberUserIds(organizationId)
      .then((ids) => {
        setTeamMemberUserIds(ids);
      })
      .catch((e) => {
        console.error("Failed to load team members for reports", e);
        setTeamMemberUserIds([]);
      })
      .finally(() => {
        setTeamScopeReady(true);
      });
  }, [teamScoped, organizationId, canViewTeamReports]);

  useEffect(() => {
    if (canViewReports && organizationId && teamScopeReady) {
      void fetchUsers();
      void fetchCategories();
    }
  }, [canViewReports, organizationId, teamScopeReady, teamMemberUserIds, teamScoped]);

  useEffect(() => {
    if (!canViewReports || !organizationId || !dailyProjectReportEnabled) {
      setDailyReportConfig(null);
      setDailyConfigReady(false);
      dailyReportConfigRef.current = null;
      return;
    }
    void loadDailyReportConfig();
  }, [canViewReports, organizationId, dailyProjectReportEnabled]);

  const loadDailyReportConfig = async (): Promise<DailyExpenseReportConfig | null> => {
    if (!organizationId) return null;
    const { config } = await fetchOrganizationDailyReportConfig(organizationId);
    setDailyReportConfig(config);
    dailyReportConfigRef.current = config;
    const ready = isDailyReportConfigReady(config);
    setDailyConfigReady(ready);
    return ready ? config : null;
  };

  // Report data is fetched via React Query (see useQuery hooks below).
  // Changing filters changes the query key → React Query auto-fetches.

  // Daily report is fetched via React Query dailyQuery (see below).

  const employeeFilledSets = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    for (const [key, values] of Object.entries(employeeFilledFieldValues)) {
      out[key] = new Set(values);
    }
    return out;
  }, [employeeFilledFieldValues]);

  const detailedCustomFilterFields = useMemo(
    () => mergeFilterableFieldsWithEmployeeData(filterableCustomFields, employeeFilledSets),
    [filterableCustomFields, employeeFilledSets],
  );

  useEffect(() => {
    if (activeTab !== "detailed" || !organizationId) {
      setEmployeeFilledFieldValues({});
      return;
    }

    let cancelled = false;
    setLoadingEmployeeFieldOptions(true);

    const period = {
      year: selectedYear,
      month: selectedMonth,
      category: selectedCategory,
    };

    const loadFilled =
      selectedEmployee === "all"
        ? fetchFilledCustomFieldValuesForOrganization(organizationId, period)
        : fetchFilledCustomFieldValuesForEmployee(organizationId, selectedEmployee, period);

    void loadFilled
      .then((filled) => {
        if (cancelled) return;
        const serializable: Record<string, string[]> = {};
        for (const [key, valueSet] of Object.entries(filled)) {
          serializable[key] = [...valueSet];
        }
        setEmployeeFilledFieldValues(serializable);
      })
      .catch((error) => {
        console.warn("Failed to load custom field filter options", error);
        if (!cancelled) setEmployeeFilledFieldValues({});
      })
      .finally(() => {
        if (!cancelled) setLoadingEmployeeFieldOptions(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    organizationId,
    selectedEmployee,
    selectedYear,
    selectedMonth,
    selectedCategory,
  ]);

  const handleDetailedEmployeeChange = (userId: string) => {
    setSelectedEmployee(userId);
  };

  useEffect(() => {
    if (activeTab !== "detailed") return;
    setCustomFieldFilters((prev) => {
      const next = { ...prev };
      for (const field of detailedCustomFilterFields) {
        if (!(field.key in next)) next[field.key] = CUSTOM_FIELD_FILTER_ALL;
      }
      return next;
    });
  }, [detailedCustomFilterFields, activeTab]);

  const fetchUsers = async () => {
    if (!organizationId) {
      setUsers([]);
      return;
    }
    try {
      if (teamScoped) {
        const ids = teamMemberUserIds.length
          ? teamMemberUserIds
          : await fetchTeamMemberUserIds(organizationId);
        if (ids.length === 0) {
          setUsers([]);
          return;
        }
        const profiles = await fetchSubmitterProfiles(organizationId, ids);
        setUsers(
          profiles.map((p) => ({
            user_id: p.user_id,
            name: p.name,
            email: p.email,
            employee_id: p.employee_id,
            balance: Number(p.balance ?? 0),
            role: "employee",
          })),
        );
        return;
      }
      const rows = await fetchOrganizationUsers(organizationId);
      setUsers(rows);
    } catch (e) {
      console.error("Failed to fetch users for reports", e);
      setUsers([]);
    }
  };

  // ── Scope key: deterministic string representing who this report covers ────
  const scopeKey = useMemo(
    () =>
      teamScoped
        ? `team:${[...teamMemberUserIds].sort().join(",")}`
        : "org",
    [teamScoped, teamMemberUserIds],
  );

  // Daily config signature: changes when config changes, drives query key
  const dailyConfigSignature = useMemo(
    () => (dailyReportConfig ? JSON.stringify(dailyReportConfig) : "none"),
    [dailyReportConfig],
  );

  const dailyAllTime = dailyPeriodMode === "all_time";

  // ── Report queries ─────────────────────────────────────────────────────────
  const QUERY_DEFAULTS = {
    staleTime: 0,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchOnMount: "always" as const,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  } as const;

  const verificationQuery = useQuery({
    queryKey: reportKeys.verification(
      organizationId ?? "",
      scopeKey,
      selectedEmployee,
      selectedCategory,
      engineerStatus,
    ),
    queryFn: () =>
      loadVerificationReport({
        organizationId: organizationId!,
        teamScoped,
        teamMemberUserIds,
        selectedEmployee,
        selectedCategory,
        engineerStatus,
      }),
    enabled:
      activeTab === "verification" &&
      Boolean(organizationId) &&
      canViewReports &&
      teamScopeReady,
    ...QUERY_DEFAULTS,
  });

  const approvalQuery = useQuery({
    queryKey: reportKeys.approval(
      organizationId ?? "",
      scopeKey,
      selectedEmployee,
      selectedCategory,
      engineerStatus,
    ),
    queryFn: () =>
      loadApprovalReport({
        organizationId: organizationId!,
        teamScoped,
        teamMemberUserIds,
        selectedEmployee,
        selectedCategory,
        engineerStatus,
      }),
    enabled:
      activeTab === "approval" &&
      Boolean(organizationId) &&
      canViewReports &&
      teamScopeReady,
    ...QUERY_DEFAULTS,
  });

  const detailedQuery = useQuery({
    queryKey: reportKeys.detailed(
      organizationId ?? "",
      scopeKey,
      selectedEmployee,
      selectedCategory,
      selectedYear,
      selectedMonth,
      selectedWeek,
    ),
    queryFn: () =>
      loadDetailedReport({
        organizationId: organizationId!,
        teamScoped,
        teamMemberUserIds,
        selectedEmployee,
        selectedCategory,
        selectedYear,
        selectedMonth,
      }),
    enabled:
      activeTab === "detailed" &&
      Boolean(organizationId) &&
      canViewReports &&
      teamScopeReady,
    ...QUERY_DEFAULTS,
  });

  const dailyQuery = useQuery({
    queryKey: reportKeys.daily(
      organizationId ?? "",
      scopeKey,
      selectedEmployee,
      dailyPeriodMode,
      dailyAllTime ? "all" : dailyDateFrom,
      dailyAllTime ? "all" : dailyDateTo,
      dailyConfigSignature,
    ),
    // React Query gives one in-flight fetch per key and hands us its
    // AbortController, so a tab change / re-filter / unmount cancels the
    // in-progress export instead of leaving pages racing (single-flight).
    queryFn: async ({ signal }) => {
      setDailyProgress({ received: 0, total: null, pages: 0 });
      try {
        return await loadDailyReport({
          organizationId: organizationId!,
          teamScoped,
          teamMemberUserIds,
          selectedEmployee,
          dailyPeriodMode,
          dailyDateFrom,
          dailyDateTo,
          signal,
          onProgress: setDailyProgress,
        });
      } finally {
        setDailyProgress(null);
      }
    },
    enabled:
      activeTab === "daily" &&
      dailyProjectReportEnabled &&
      dailyConfigReady &&
      Boolean(organizationId) &&
      canViewReports &&
      teamScopeReady,
    ...QUERY_DEFAULTS,
  });

  // ── Realtime: invalidate report queries when expenses change ───────────────
  useEffect(() => {
    if (!organizationId) return;
    let debounceTimer: ReturnType<typeof setTimeout>;
    const channel = supabase
      .channel(`reports-rt-${organizationId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "expenses",
          filter: `organization_id=eq.${organizationId}`,
        },
        () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            void queryClient.invalidateQueries({
              queryKey: reportKeys.all(organizationId),
            });
          }, 1000);
        },
      )
      .subscribe();

    return () => {
      clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [organizationId, queryClient]);

  // ── Derived data from queries ──────────────────────────────────────────────
  const verificationExpenses = verificationQuery.data ?? [];
  const approvalExpenses = approvalQuery.data ?? [];
  const detailedExpenses = detailedQuery.data?.expenses ?? [];
  const detailedAllocations = detailedQuery.data?.allocations ?? [];
  const dailyReportResults = dailyQuery.data ?? [];
  const dailyReportRows = useMemo(
    () => dailyReportResultsToRows(dailyReportResults),
    [dailyReportResults],
  );

  const dailyReviewRowCount = useMemo(
    () => dailyReportRows.filter(isDailyReportRowNeedsReview).length,
    [dailyReportRows],
  );

  // Active query drives RefreshBar and export-disable
  const activeQuery =
    activeTab === "verification"
      ? verificationQuery
      : activeTab === "approval"
        ? approvalQuery
        : activeTab === "detailed"
          ? detailedQuery
          : dailyQuery;

  const fetchCategories = async () => {
    if (!organizationId) {
      setCategories([]);
      return;
    }
    try {
      let data: { name: string }[] | null = null;
      let error: unknown = null;

      const attempts = [
        () =>
          supabase
            .from("expense_categories")
            .select("name")
            .eq("organization_id", organizationId)
            .eq("active", true)
            .order("name", { ascending: true }),
        () =>
          supabase
            .from("expense_categories")
            .select("name")
            .eq("organization_id", organizationId)
            .eq("is_active", true)
            .order("name", { ascending: true }),
        () =>
          supabase
            .from("expense_categories")
            .select("name")
            .eq("organization_id", organizationId)
            .order("name", { ascending: true }),
      ];

      for (const run of attempts) {
        const result = await run();
        if (!result.error) {
          data = result.data as { name: string }[] | null;
          error = null;
          break;
        }
        error = result.error;
        if (!isSchemaMismatchError(result.error)) break;
      }

      if (error) throw error;
      setCategories((data || []).map((r) => r.name).filter(Boolean));
    } catch (e) {
      console.warn("Categories not available", e);
      setCategories([]);
    }
  };

  const escapeCsv = (val: string | number): string => {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const downloadBlob = (filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  type ExportFormat = "xlsx" | "csv" | "json" | "pdf";

  const exportVerificationList = (format: ExportFormat) => {
    const baseName = `claim-verification-list-${new Date().toISOString().slice(0, 10)}`;
    const col = {
      user: t("columns.user"),
      employeeId: "Employee ID",
      employeeEmail: t("columns.employeeEmail"),
      transactionNumber: t("columns.transactionNumber"),
      title: t("columns.title"),
      purpose: t("columns.purpose"),
      destination: t("columns.destination"),
      batch: t("columns.batch"),
      expenseType: t("columns.expenseType"),
      lpoNumber: t("columns.lpoNumber"),
      billDate: t("columns.billDate"),
      tripEnd: t("columns.tripEnd"),
      billAmount: t("columns.billAmount"),
      status: t("columns.status"),
      managerApproval: t("columns.managerApproval"),
      hoApproval: t("columns.hoApproval"),
      submittedOn: t("columns.submittedOn"),
      openingBalance: t("columns.openingBalance"),
      closingBalance: t("columns.closingBalance"),
    };
    const fixedHeaders = [
      col.user,
      col.employeeId,
      col.employeeEmail,
      col.transactionNumber,
      col.title,
      col.purpose,
      col.destination,
      col.batch,
      col.expenseType,
      col.lpoNumber,
      col.billDate,
      col.tripEnd,
      col.billAmount,
      col.status,
      col.managerApproval,
      col.hoApproval,
      col.submittedOn,
    ];
    const headers = [...fixedHeaders, ...verificationCustomKeys, col.openingBalance, col.closingBalance];
    const rows = filteredVerificationExpenses.map((exp) => {
      const bal = verificationRowBalances.get(exp.id) ?? { opening: 0, closing: 0 };
      const row: Record<string, string> = {
        [col.user]: exp.user_name,
        [col.employeeId]: exp.employee_id || "",
        [col.employeeEmail]: exp.user_email,
        [col.transactionNumber]: exp.transaction_number || "",
        [col.title]: exp.title || "",
        [col.purpose]: exp.purpose || "",
        [col.destination]: exp.destination || "",
        [col.batch]: exp.batch_ref,
        [col.expenseType]: exp.category || "-",
        [col.lpoNumber]: "-",
        [col.billDate]: formatDateDDMMYYYY(exp.trip_start),
        [col.tripEnd]: formatDateDDMMYYYY(exp.trip_end),
        [col.billAmount]: formatINR(Number(exp.total_amount || 0)),
        [col.status]: exp.status || "",
        [col.managerApproval]: "Verified",
        [col.hoApproval]: "Pending",
        [col.submittedOn]: formatDateDDMMYYYY(exp.created_at),
        [col.openingBalance]: formatINR(bal.opening),
        [col.closingBalance]: formatINR(bal.closing),
      };
      verificationCustomKeys.forEach((k) => {
        row[k] = exp.custom_fields?.[k] ?? "";
      });
      return row;
    });

    if (format === "csv") {
      const csv = [headers.map(escapeCsv).join(","), ...rows.map((r) => headers.map((h) => escapeCsv((r as Record<string, string>)[h] ?? "")).join(","))].join("\n");
      downloadBlob(`${baseName}.csv`, new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    } else if (format === "json") {
      downloadBlob(`${baseName}.json`, new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
    } else if (format === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Verification List");
      XLSX.writeFile(wb, `${baseName}.xlsx`);
    } else {
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFillColor(30, 58, 95);
      doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("Claim Verification List", 14, 16);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(
        t("generatedAt", {
          date: new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
        }),
        14,
        24,
      );
      doc.setTextColor(0, 0, 0);
      autoTable(doc, {
        startY: 32,
        head: [headers],
        body: rows.map((r) => headers.map((h) => (r as Record<string, string>)[h] ?? "")),
        theme: "striped",
        headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold", fontSize: 7 },
        bodyStyles: { fontSize: 6, textColor: [33, 37, 41] },
        alternateRowStyles: { fillColor: [248, 249, 250] },
        margin: { left: 10, right: 10 },
        styles: { fontSize: 6, cellPadding: 1 },
      });
      doc.save(`${baseName}.pdf`);
    }
  };

  const exportApprovalList = (format: ExportFormat) => {
    const baseName = `claim-approval-list-${new Date().toISOString().slice(0, 10)}`;
    const col = {
      user: t("columns.user"),
      employeeId: "Employee ID",
      employeeEmail: t("columns.employeeEmail"),
      transactionNumber: t("columns.transactionNumber"),
      title: t("columns.title"),
      purpose: t("columns.purpose"),
      destination: t("columns.destination"),
      batch: t("columns.batch"),
      expenseType: t("columns.expenseType"),
      lpoNumber: t("columns.lpoNumber"),
      billDate: t("columns.billDate"),
      tripEnd: t("columns.tripEnd"),
      billAmount: t("columns.billAmount"),
      status: t("columns.status"),
      managerApproval: t("columns.managerApproval"),
      hoApproval: t("columns.hoApproval"),
      submittedOn: t("columns.submittedOn"),
      openingBalance: t("columns.openingBalance"),
      closingBalance: t("columns.closingBalance"),
    };
    const fixedHeaders = [
      col.user,
      col.employeeId,
      col.employeeEmail,
      col.transactionNumber,
      col.title,
      col.purpose,
      col.destination,
      col.batch,
      col.expenseType,
      col.lpoNumber,
      col.billDate,
      col.tripEnd,
      col.billAmount,
      col.status,
      col.managerApproval,
      col.hoApproval,
      col.submittedOn,
    ];
    const headers = [...fixedHeaders, ...approvalCustomKeys, col.openingBalance, col.closingBalance];
    const rows = filteredApprovalExpenses.map((exp) => {
      const bal = approvalRowBalances.get(exp.id) ?? { opening: 0, closing: 0 };
      const row: Record<string, string> = {
        [col.user]: exp.user_name,
        [col.employeeId]: exp.employee_id || "",
        [col.employeeEmail]: exp.user_email,
        [col.transactionNumber]: exp.transaction_number || "",
        [col.title]: exp.title || "",
        [col.purpose]: exp.purpose || "",
        [col.destination]: exp.destination || "",
        [col.batch]: exp.batch_ref,
        [col.expenseType]: exp.category || "-",
        [col.lpoNumber]: "-",
        [col.billDate]: formatDateDDMMYYYY(exp.trip_start),
        [col.tripEnd]: formatDateDDMMYYYY(exp.trip_end),
        [col.billAmount]: formatINR(Number(exp.total_amount || 0)),
        [col.status]: exp.status || "",
        [col.managerApproval]: "Verified",
        [col.hoApproval]: "Approved",
        [col.submittedOn]: formatDateDDMMYYYY(exp.created_at),
        [col.openingBalance]: formatINR(bal.opening),
        [col.closingBalance]: formatINR(bal.closing),
      };
      approvalCustomKeys.forEach((k) => {
        row[k] = exp.custom_fields?.[k] ?? "";
      });
      return row;
    });

    if (format === "csv") {
      const csv = [headers.map(escapeCsv).join(","), ...rows.map((r) => headers.map((h) => escapeCsv((r as Record<string, string>)[h] ?? "")).join(","))].join("\n");
      downloadBlob(`${baseName}.csv`, new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    } else if (format === "json") {
      downloadBlob(`${baseName}.json`, new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }));
    } else if (format === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Approval List");
      XLSX.writeFile(wb, `${baseName}.xlsx`);
    } else {
      const doc = new jsPDF({ orientation: "landscape" });
      doc.setFillColor(30, 58, 95);
      doc.rect(0, 0, doc.internal.pageSize.getWidth(), 28, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("Claim Approval List", 14, 16);
      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(
        t("generatedAt", {
          date: new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
        }),
        14,
        24,
      );
      doc.setTextColor(0, 0, 0);
      autoTable(doc, {
        startY: 32,
        head: [headers],
        body: rows.map((r) => headers.map((h) => (r as Record<string, string>)[h] ?? "")),
        theme: "striped",
        headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold", fontSize: 7 },
        bodyStyles: { fontSize: 6, textColor: [33, 37, 41] },
        alternateRowStyles: { fillColor: [248, 249, 250] },
        margin: { left: 10, right: 10 },
        styles: { fontSize: 6, cellPadding: 1 },
      });
      doc.save(`${baseName}.pdf`);
    }
  };

  const exportDetailedReport = (format: ExportFormat) => {
    const employeeName = selectedUser?.name ?? "All";
    const safeName = employeeName.replace(/[^a-zA-Z0-9-_]/g, "-");
    const baseName = `detailed-expense-report-${safeName}-${selectedYear}-${new Date().toISOString().slice(0, 10)}`;

    const headers = showDetailedBalanceColumns
      ? [
        "Bill Date",
        "Title",
        "Type of Expense",
        "Purpose",
        "Destination",
        "Batch",
        ...detailedCustomKeys,
        "Credit",
        "Debit",
        "Notes",
        "Opening Balance",
        "Closing Balance",
      ]
      : [
        "Employee",
        "Employee ID",
        "Bill Date",
        "Title",
        "Type of Expense",
        "Purpose",
        "Destination",
        "Batch",
        ...detailedCustomKeys,
        "Credit",
        "Debit",
        "Notes",
      ];

    const detailRows = showDetailedBalanceColumns
      ? detailedListWithBalances.map((row) => {
        const r: Record<string, string> = {
          "Bill Date": formatDateDDMMYYYY(row.date),
          Title: row.type === "expense" ? row.title ?? "" : "",
          "Type of Expense": row.category,
          Purpose: row.purpose ?? "-",
          Destination: row.destination ?? "-",
          Batch: row.type === "expense" ? row.batchRef : "-",
          Credit: row.credit > 0 ? formatINR(row.credit) : "",
          Debit: row.debit > 0 ? formatINR(row.debit) : "",
          Notes: row.notes,
          "Opening Balance": formatINR(row.openingBalance),
          "Closing Balance": formatINR(row.closingBalance),
        };
        detailedCustomKeys.forEach((k) => {
          r[k] = row.type === "expense" ? row.customFields?.[k] ?? "" : "";
        });
        return r;
      })
      : detailedAllEmployeesRows.map((exp) => {
        const r: Record<string, string> = {
          Employee: exp.user_name,
          "Employee ID": exp.employee_id || "",
          "Bill Date": formatDateDDMMYYYY(exp.trip_start),
          Title: exp.title ?? "",
          "Type of Expense": exp.category ?? "-",
          Purpose: exp.purpose ?? "-",
          Destination: exp.destination ?? "-",
          Batch: exp.batch_ref,
          Credit: "",
          Debit: formatINR(Number(exp.total_amount || 0)),
          Notes: exp.purpose || "-",
        };
        detailedCustomKeys.forEach((k) => {
          r[k] = exp.custom_fields?.[k] ?? "";
        });
        return r;
      });

    const summaryRows: Record<string, string>[] = [];
    if (totalAllocationsInPeriod > 0) summaryRows.push({ Category: "Account Credited", Amount: formatINR(totalAllocationsInPeriod) });
    if (totalReturnsInPeriod > 0) summaryRows.push({ Category: "Money Returned", Amount: formatINR(totalReturnsInPeriod) });
    Object.entries(detailedSummary).forEach(([category, amount]) => summaryRows.push({ Category: category, Amount: formatINR(amount) }));
    summaryRows.push({ Category: "Total", Amount: formatINR(totalAmount) });

    const reconstructedClosing = detailedListWithBalances.length > 0 ? detailedListWithBalances[detailedListWithBalances.length - 1].closingBalance : balanceInfo.closing;

    const emptyHeaderRow = (): Record<string, string> => {
      const o: Record<string, string> = {};
      headers.forEach((h) => {
        o[h] = "";
      });
      return o;
    };

    if (format === "csv") {
      const lines: string[] = [headers.map(escapeCsv).join(",")];
      if (showDetailedBalanceColumns) {
        const openMeta = emptyHeaderRow();
        openMeta["Type of Expense"] = "Opening Balance";
        openMeta["Opening Balance"] = formatINR(balanceInfo.opening);
        openMeta["Closing Balance"] = formatINR(balanceInfo.opening);
        lines.push(headers.map((h) => escapeCsv(openMeta[h] ?? "")).join(","));
      }
      detailRows.forEach((dr) => {
        lines.push(headers.map((h) => escapeCsv(dr[h] ?? "")).join(","));
      });
      if (showDetailedBalanceColumns) {
        const closeMeta = emptyHeaderRow();
        closeMeta["Type of Expense"] = "Closing Balance";
        closeMeta["Opening Balance"] = formatINR(reconstructedClosing);
        closeMeta["Closing Balance"] = formatINR(reconstructedClosing);
        lines.push(headers.map((h) => escapeCsv(closeMeta[h] ?? "")).join(","));
      }
      lines.push("");
      lines.push(["Summary", ""].map(escapeCsv).join(","));
      if (totalAllocationsInPeriod > 0) lines.push(["Account Credited", formatINR(totalAllocationsInPeriod)].map(escapeCsv).join(","));
      if (totalReturnsInPeriod > 0) lines.push(["Money Returned", formatINR(totalReturnsInPeriod)].map(escapeCsv).join(","));
      Object.entries(detailedSummary).forEach(([category, amount]) => lines.push([category, formatINR(amount)].map(escapeCsv).join(",")));
      lines.push(["Total", formatINR(totalAmount)].map(escapeCsv).join(","));
      downloadBlob(`${baseName}.csv`, new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    } else if (format === "json") {
      const payload = {
        employee: employeeName,
        year: selectedYear,
        openingBalance: balanceInfo.opening,
        closingBalance: reconstructedClosing,
        detailedList: detailRows,
        summary: summaryRows,
      };
      downloadBlob(`${baseName}.json`, new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    } else if (format === "xlsx") {
      const wb = XLSX.utils.book_new();
      const sheetRows: Record<string, string>[] = [];
      if (showDetailedBalanceColumns) {
        const openingRow: Record<string, string> = emptyHeaderRow();
        openingRow["Type of Expense"] = "Opening Balance";
        openingRow["Opening Balance"] = formatINR(balanceInfo.opening);
        openingRow["Closing Balance"] = formatINR(balanceInfo.opening);
        sheetRows.push(openingRow);
      }
      sheetRows.push(...detailRows);
      if (showDetailedBalanceColumns) {
        const closingRow: Record<string, string> = emptyHeaderRow();
        closingRow["Type of Expense"] = "Closing Balance";
        closingRow["Opening Balance"] = formatINR(reconstructedClosing);
        closingRow["Closing Balance"] = formatINR(reconstructedClosing);
        sheetRows.push(closingRow);
      }
      const wsDetail = XLSX.utils.json_to_sheet(sheetRows);
      XLSX.utils.book_append_sheet(wb, wsDetail, "Detailed List");
      const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
      XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");
      XLSX.writeFile(wb, `${baseName}.xlsx`);
    } else {
      const doc = new jsPDF({ orientation: "landscape" });
      const pageW = doc.internal.pageSize.getWidth();
      const margin = 14;

      doc.setFillColor(30, 58, 95);
      doc.rect(0, 0, pageW, 36, "F");
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("Detailed Expense Report", margin, 16);
      doc.setFontSize(11);
      doc.setFont("helvetica", "normal");
      doc.text(`${employeeName}  •  Year ${selectedYear}`, margin, 26);
      doc.setFontSize(9);
      doc.text(`Generated: ${new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`, pageW - margin, 26, { align: "right" });
      doc.setTextColor(0, 0, 0);

      const truncate = (s: string, maxLen: number) => (s.length <= maxLen ? s : s.slice(0, maxLen - 2) + "…");

      const openMeta = emptyHeaderRow();
      openMeta["Type of Expense"] = "Opening Balance";
      openMeta["Opening Balance"] = formatINR(balanceInfo.opening);
      openMeta["Closing Balance"] = formatINR(balanceInfo.opening);
      const closeMeta = emptyHeaderRow();
      closeMeta["Type of Expense"] = "Closing Balance";
      closeMeta["Opening Balance"] = formatINR(reconstructedClosing);
      closeMeta["Closing Balance"] = formatINR(reconstructedClosing);

      const pdfDetailRows = detailRows.map((dr) =>
        headers.map((h) => {
          const v = dr[h] ?? "";
          if (
            h === "Notes" ||
            h === "Purpose" ||
            h === "Destination" ||
            h === "Batch" ||
            h === "Employee" ||
            detailedCustomKeys.includes(h)
          ) {
            return truncate(v, 28);
          }
          return v;
        }),
      );

      const detailBody: string[][] = showDetailedBalanceColumns
        ? [
          headers.map((h) => truncate(openMeta[h] ?? "", 28)),
          ...pdfDetailRows,
          headers.map((h) => truncate(closeMeta[h] ?? "", 28)),
        ]
        : pdfDetailRows;

      const idxCredit = headers.indexOf("Credit");
      const idxDebit = headers.indexOf("Debit");
      const idxOb = headers.indexOf("Opening Balance");
      const idxCb = headers.indexOf("Closing Balance");
      const columnStyles: Record<number, { halign: string }> = {};
      [idxCredit, idxDebit, idxOb, idxCb].forEach((i) => {
        if (i >= 0) columnStyles[i] = { halign: "right" };
      });

      autoTable(doc, {
        startY: 42,
        head: [headers],
        body: detailBody,
        theme: "striped",
        headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold", fontSize: 6 },
        bodyStyles: { fontSize: 6, textColor: [33, 37, 41] },
        alternateRowStyles: { fillColor: [248, 249, 250] },
        margin: { left: margin, right: margin },
        columnStyles,
        styles: { fontSize: 6, cellPadding: 1 },
        didDrawTable: (data) => {
          (doc as any).lastAutoTable = data;
        },
      });
      const finalY = (doc as any).lastAutoTable?.finalY ?? 42;

      doc.setFontSize(12);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(30, 58, 95);
      doc.text("Summary", margin, finalY + 14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);

      autoTable(doc, {
        startY: finalY + 18,
        head: [["Category", "Amount"]],
        body: summaryRows.map((r) => [r.Category, r.Amount]),
        theme: "striped",
        headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: "bold", fontSize: 9 },
        bodyStyles: { fontSize: 9, textColor: [33, 37, 41] },
        alternateRowStyles: { fillColor: [248, 249, 250] },
        margin: { left: margin, right: margin },
        columnStyles: { 1: { halign: "right" } },
      });

      doc.save(`${baseName}.pdf`);
    }
  };

  const exportDailyProjectReport = (format: "xlsx" | "csv") => {
    downloadDailyProjectExpenseReportFile({
      rows: dailyReportRows,
      dateFrom: dailyAllTime ? null : dailyDateFrom,
      dateTo: dailyAllTime ? null : dailyDateTo,
      format,
    });
  };

  const openExportDialog = (tab: "verification" | "approval" | "detailed" | "daily") => {
    if (tab === "daily" && !dailyConfigReady) {
      toast({
        variant: "destructive",
        title: t("daily.configRequiredTitle"),
        description: t("daily.configRequiredHint"),
      });
      return;
    }
    setExportTab(tab);
    setExportDialogOpen(true);
  };

  const handleExportAs = (format: ExportFormat) => {
    if (exportTab === "verification") exportVerificationList(format);
    else if (exportTab === "approval") exportApprovalList(format);
    else if (exportTab === "detailed") exportDetailedReport(format);
    else if (exportTab === "daily" && (format === "csv" || format === "xlsx")) {
      exportDailyProjectReport(format);
    }
    setExportDialogOpen(false);
  };

  const formatDateDDMMYYYY = (dateString: string | null): string => {
    if (!dateString) return "-";
    try {
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    } catch {
      return "-";
    }
  };

  const clearFilters = () => {
    setSelectedEmployee("all");
    setSelectedCategory("all");
    setEngineerStatus("all");
    setHoStatus("approved");
    setSelectedYear(new Date().getFullYear().toString());
    setSelectedMonth("all");
    setSelectedWeek("all");
    resetCustomFieldFilters();
    setEmployeeFilledFieldValues({});
  };

  const filteredVerificationExpenses = useMemo(
    () => filterExpensesByCustomFields(verificationExpenses, customFieldFilters),
    [verificationExpenses, customFieldFilters],
  );

  const filteredApprovalExpenses = useMemo(
    () => filterExpensesByCustomFields(approvalExpenses, customFieldFilters),
    [approvalExpenses, customFieldFilters],
  );

  const filteredDetailedExpenses = useMemo(
    () => filterExpensesByCustomFields(detailedExpenses, customFieldFilters),
    [detailedExpenses, customFieldFilters],
  );

  const detailedCustomFilterHasNoData = useMemo(() => {
    if (selectedEmployee === "all") return false;
    for (const [fieldKey, filterVal] of Object.entries(customFieldFilters)) {
      if (!filterVal || filterVal === CUSTOM_FIELD_FILTER_ALL) continue;
      if (!isCustomFieldChoiceFilled(fieldKey, filterVal, employeeFilledSets)) {
        return true;
      }
    }
    return false;
  }, [selectedEmployee, customFieldFilters, employeeFilledSets]);

  // Calculate summary for detailed report
  const detailedSummary = useMemo(() => {
    const summary: Record<string, number> = {};
    filteredDetailedExpenses.forEach(exp => {
      const cat = exp.category || "Other";
      summary[cat] = (summary[cat] || 0) + Number(exp.total_amount || 0);
    });
    return summary;
  }, [filteredDetailedExpenses]);

  const totalAmount = useMemo(() => {
    return filteredDetailedExpenses.reduce((sum, exp) => sum + Number(exp.total_amount || 0), 0);
  }, [filteredDetailedExpenses]);

  // Get selected user for detailed report
  const selectedUser = useMemo(() => {
    if (selectedEmployee === "all") return null;
    return users.find(u => u.user_id === selectedEmployee);
  }, [selectedEmployee, users]);

  // Total allocations (money added to employee) in the report period
  const totalAllocationsInPeriod = useMemo(() => {
    if (!selectedUser) return 0;
    return detailedAllocations
      .filter((a) => a.recipient_id === selectedUser.user_id)
      .reduce((sum, a) => sum + a.amount, 0);
  }, [detailedAllocations, selectedUser]);

  // Total returns (money sent back by employee) in the report period
  const totalReturnsInPeriod = useMemo(() => {
    if (!selectedUser) return 0;
    return detailedAllocations
      .filter((a) => a.transferrer_id === selectedUser.user_id)
      .reduce((sum, a) => sum + a.amount, 0);
  }, [detailedAllocations, selectedUser]);

  // Total approved expenses (money spent/deducted) in the report period
  const totalApprovedExpensesInPeriod = useMemo(() => {
    return filteredDetailedExpenses.reduce((sum, e) => sum + Number(e.total_amount || 0), 0);
  }, [filteredDetailedExpenses]);

  // Calculate opening/closing balance for detailed report
  const balanceInfo = useMemo(() => {
    if (!selectedUser) return { opening: 0, allocated: 0, closing: 0 };
    const closing = Number(selectedUser.balance);
    // Period opening = current - incoming credits + approved expense debits + return debits
    const opening = closing - totalAllocationsInPeriod + totalApprovedExpensesInPeriod + totalReturnsInPeriod;
    return { opening, allocated: totalAllocationsInPeriod, closing };
  }, [selectedUser, totalAllocationsInPeriod, totalApprovedExpensesInPeriod, totalReturnsInPeriod]);

  // Combined list: allocations + expenses, sorted by date, with running opening/closing balance per row
  const detailedListWithBalances = useMemo(() => {
    if (!selectedUser) return [];

    const allocationRows = detailedAllocations
      .map((a) => {
        const isIncoming = a.recipient_id === selectedUser.user_id;
        const isOutgoing = a.transferrer_id === selectedUser.user_id;
        if (!isIncoming && !isOutgoing) return null;

        const transferNoteMap: Record<string, string> = {
          admin_to_employee: "Account credited by Admin",
          admin_to_engineer: "Account credited by Admin",
          cashier_to_employee: "Account credited by Cashier",
          cashier_to_engineer: "Account credited by Cashier",
          employee_to_cashier: "Money returned to Cashier",
          engineer_to_cashier: "Money returned to Cashier",
          cashier_to_admin: "Money returned to Admin",
          admin_to_admin: "Transfer between Admin accounts",
        };

        const note = (a.notes && a.notes.trim())
          ? a.notes
          : (transferNoteMap[a.transfer_type] || (isIncoming ? "Account credited" : "Money returned"));

        return {
          id: `alloc-${a.id}`,
          date: a.transferred_at,
          type: "allocation" as const,
          amount: a.amount,
          credit: isIncoming ? a.amount : 0,
          debit: isOutgoing ? a.amount : 0,
          notes: note,
          category: isIncoming ? "Account Credited" : "Money Returned",
          title: "",
          purpose: note,
          destination: "-",
          batchRef: "-",
          isApproved: true,
          customFields: {} as Record<string, string>,
        };
      })
      .filter(Boolean) as Array<{
        id: string;
        date: string;
        type: "allocation";
        amount: number;
        credit: number;
        debit: number;
        notes: string;
        category: string;
        title: string;
        purpose: string;
        destination: string;
        batchRef: string;
        isApproved: boolean;
        customFields: Record<string, string>;
      }>;

    const expenseRows = filteredDetailedExpenses.map((e) => ({
      id: e.id,
      date: e.trip_start,
      type: "expense" as const,
      amount: Number(e.total_amount || 0),
      credit: 0,
      debit: Number(e.total_amount || 0),
      notes: e.purpose || "-",
      category: e.category || "-",
      title: e.title || "",
      purpose: e.purpose || "-",
      destination: e.destination || "-",
      batchRef: e.batch_ref,
      isApproved: true,
      customFields: e.custom_fields ?? {},
    }));

    const combined = [...allocationRows, ...expenseRows].sort((a, b) => {
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      if (da !== db) return da - db;
      // Same date: allocations before expenses
      return a.type === "allocation" ? -1 : 1;
    });

    // Running balance: apply every credit and debit in the list so balances are consistent and can go negative
    let running = balanceInfo.opening;
    return combined.map((row) => {
      const opening = running;
      running += row.credit - row.debit;
      return { ...row, openingBalance: opening, closingBalance: running };
    });
  }, [selectedUser, detailedAllocations, filteredDetailedExpenses, balanceInfo.opening]);

  const detailedAllEmployeesRows = useMemo(() => {
    return [...filteredDetailedExpenses].sort((a, b) => {
      const da = new Date(a.trip_start).getTime();
      const db = new Date(b.trip_start).getTime();
      return da - db;
    });
  }, [filteredDetailedExpenses]);

  const showDetailedBalanceColumns = Boolean(selectedUser);

  const userBalancesByUserId = useMemo(
    () => Object.fromEntries(users.map((u) => [u.user_id, u.balance])),
    [users]
  );

  const verificationRowBalances = useMemo(
    () => computeRowBalancesForVerification(filteredVerificationExpenses, userBalancesByUserId),
    [filteredVerificationExpenses, userBalancesByUserId]
  );

  const approvalRowBalances = useMemo(
    () => computeRowBalancesForApproval(filteredApprovalExpenses, userBalancesByUserId),
    [filteredApprovalExpenses, userBalancesByUserId]
  );

  const verificationCustomKeys = useMemo(
    () => sortedCustomFieldKeys(filteredVerificationExpenses),
    [filteredVerificationExpenses],
  );
  const approvalCustomKeys = useMemo(
    () => sortedCustomFieldKeys(filteredApprovalExpenses),
    [filteredApprovalExpenses],
  );
  const detailedCustomKeys = useMemo(
    () => sortedCustomFieldKeys(filteredDetailedExpenses),
    [filteredDetailedExpenses],
  );

  if (!canViewReports) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-500">
          {teamScoped
            ? "Team reports are available to managers, executives, and team leaders when My Teams is enabled."
            : "Access denied."}
        </p>
      </div>
    );
  }

  if (teamScoped && teamScopeReady && teamMemberUserIds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 px-4 text-center">
        <p className="text-slate-600 font-medium">No team members found</p>
        <p className="text-sm text-slate-500">
          Reports will appear once employees are assigned to you as supervisor or on a formal team.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">
          {teamScoped ? "Team Reports" : t("title")}
        </h1>
        <p className="text-sm text-slate-600">
          {teamScoped
            ? `Expense reports for your team only (${teamMemberUserIds.length} member${teamMemberUserIds.length === 1 ? "" : "s"}).`
            : t("description")}
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="w-full">
        {isMobile ? (
          <Select value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="verification">Claim Verification List</SelectItem>
              <SelectItem value="approval">Claim Approval List</SelectItem>
              <SelectItem value="detailed">Detailed Expense Report</SelectItem>
              {dailyProjectReportEnabled && (
                <SelectItem value="daily">{t("daily.tabTitle")}</SelectItem>
              )}
            </SelectContent>
          </Select>
        ) : (
          <TabsList
            className={`grid w-full ${dailyProjectReportEnabled ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"}`}
          >
            <TabsTrigger value="verification">Claim Verification List</TabsTrigger>
            <TabsTrigger value="approval">Claim Approval List</TabsTrigger>
            <TabsTrigger value="detailed">Detailed Expense Report</TabsTrigger>
            {dailyProjectReportEnabled && (
              <TabsTrigger value="daily">{t("daily.tabTitle")}</TabsTrigger>
            )}
          </TabsList>
        )}

        {/* Claim Verification List */}
        <TabsContent value="verification" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>CLAIM VERIFICATION LIST</CardTitle>
              <CardDescription>Expenses verified by managers, pending admin approval</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold">APPLIED FILTER</Label>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label>Employee</Label>
                    <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                      <SelectTrigger>
                        <SelectValue placeholder="All employees" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All employees</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.user_id} value={u.user_id}>
                            {formatReportUserLabel(u)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Expense Type</Label>
                    <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                      <SelectTrigger>
                        <SelectValue placeholder="All categories" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All categories</SelectItem>
                        {categories.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Manager Approval Status</Label>
                    <Select value={engineerStatus} onValueChange={setEngineerStatus}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All verified</SelectItem>
                        <SelectItem value="verified">Verified</SelectItem>
                        <SelectItem value="level_1_verified">Level 1 Verified</SelectItem>
                        <SelectItem value="level_2_verified">Level 2 Verified</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button onClick={() => void verificationQuery.refetch()} disabled={verificationQuery.isFetching}>Submit</Button>
                  <Button variant="outline" onClick={clearFilters}>Clear</Button>
                  <Button
                    variant="outline"
                    onClick={() => openExportDialog("verification")}
                    disabled={verificationQuery.isFetching || filteredVerificationExpenses.length === 0}
                    title={verificationQuery.isFetching ? t("liveRefresh.exportWait") : undefined}
                  >Export</Button>
                </div>
                <ExpenseCustomFieldFilters
                  fields={filterableCustomFields}
                  values={customFieldFilters}
                  onChange={setCustomFieldFilters}
                  className="pt-2"
                />
              </div>

              <ReportLiveRefreshBar query={verificationQuery} />
              {verificationQuery.isLoading ? null : filteredVerificationExpenses.length === 0 ? (
                <div className="py-8 text-center text-slate-500 text-sm">No expenses found</div>
              ) : isMobile ? (
                <div className="space-y-2" data-testid="verification-card-list">
                  {filteredVerificationExpenses.map(exp => (
                    <div key={exp.id} className="rounded-md border p-3 space-y-1" data-testid="verification-expense-card">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{exp.user_name}</span>
                        <span className="text-sm font-medium">{formatINR(Number(exp.total_amount || 0))}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {exp.title || "-"}{exp.category ? ` · ${exp.category}` : ""}
                      </div>
                      {verificationCustomKeys.filter((k) => exp.custom_fields?.[k]).map((k) => (
                        <div key={k} className="text-xs text-muted-foreground truncate">
                          <span className="font-medium">{k}:</span> {exp.custom_fields![k]}
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <StatusBadge status="verified" />
                        <Badge variant="secondary" className="text-xs">Pending HO</Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{formatDateDDMMYYYY(exp.created_at)}</span>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => navigate(`/expenses/${exp.id}`)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee ID</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Transaction #</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Title</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Purpose</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.destination")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.tripEnd")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.batch")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Expense Type</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">LPO Number</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Bill Date (DD-MM-YYYY)</th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Bill Amount</th>
                        {verificationCustomKeys.map((k) => (
                          <th key={k} className="px-4 py-3 text-left font-semibold text-slate-700 whitespace-nowrap">{k}</th>
                        ))}
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Opening Balance</th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Closing Balance</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Manager Approval</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">HO Approval</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Submitted On (DD-MM-YYYY)</th>
                        <th className="px-4 py-3 text-center font-semibold text-slate-700">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredVerificationExpenses.map(exp => (
                        <tr key={exp.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3">{exp.user_name}</td>
                          <td className="px-4 py-3 text-slate-500 font-mono text-xs">{exp.employee_id || "-"}</td>
                          <td className="px-4 py-3">{exp.transaction_number || "-"}</td>
                          <td className="px-4 py-3 max-w-[140px] truncate" title={exp.title || ""}>{exp.title || "-"}</td>
                          <td className="px-4 py-3 max-w-[160px] truncate" title={exp.purpose || ""}>{exp.purpose || "-"}</td>
                          <td className="px-4 py-3 max-w-[120px] truncate" title={exp.destination || ""}>{exp.destination || "-"}</td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.trip_end)}</td>
                          <td className="px-4 py-3 max-w-[120px] truncate" title={exp.batch_ref}>{exp.batch_ref}</td>
                          <td className="px-4 py-3">{exp.category || "-"}</td>
                          <td className="px-4 py-3">-</td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.trip_start)}</td>
                          <td className="px-4 py-3 text-right font-medium">{formatINR(Number(exp.total_amount || 0))}</td>
                          {verificationCustomKeys.map((k) => (
                            <td key={k} className="px-4 py-3 max-w-[140px] truncate text-sm" title={exp.custom_fields?.[k] ?? ""}>
                              {exp.custom_fields?.[k] ?? ""}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right text-sm">{formatINR(verificationRowBalances.get(exp.id)?.opening ?? 0)}</td>
                          <td className="px-4 py-3 text-right text-sm font-medium">{formatINR(verificationRowBalances.get(exp.id)?.closing ?? 0)}</td>
                          <td className="px-4 py-3">
                            <StatusBadge status="verified" />
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="secondary">Pending</Badge>
                          </td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.created_at)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-2">
                              <Button variant="ghost" size="sm" onClick={() => navigate(`/expenses/${exp.id}`)}>
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => navigate(`/expenses/${exp.id}`)}>
                                <FileText className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Claim Approval List */}
        <TabsContent value="approval" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>CLAIM APPROVAL LIST</CardTitle>
              <CardDescription>Expenses approved by admin</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-sm font-semibold">APPLIED FILTER</Label>
                <div className="grid gap-4 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Employee</Label>
                    <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                      <SelectTrigger>
                        <SelectValue placeholder="All employees" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All employees</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.user_id} value={u.user_id}>
                            {formatReportUserLabel(u)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Expense Type</Label>
                    <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                      <SelectTrigger>
                        <SelectValue placeholder="All categories" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All categories</SelectItem>
                        {categories.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Manager Approval Status</Label>
                    <Select value={engineerStatus} onValueChange={setEngineerStatus}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All verified</SelectItem>
                        <SelectItem value="verified">Verified</SelectItem>
                        <SelectItem value="level_1_verified">Level 1 Verified</SelectItem>
                        <SelectItem value="level_2_verified">Level 2 Verified</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>HO Approval Status</Label>
                    <Select value={hoStatus} onValueChange={setHoStatus}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="approved">Approved</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <Button onClick={() => void approvalQuery.refetch()} disabled={approvalQuery.isFetching}>Submit</Button>
                  <Button variant="outline" onClick={clearFilters}>Clear</Button>
                  <Button
                    variant="outline"
                    onClick={() => openExportDialog("approval")}
                    disabled={approvalQuery.isFetching || filteredApprovalExpenses.length === 0}
                    title={approvalQuery.isFetching ? t("liveRefresh.exportWait") : undefined}
                  >Export</Button>
                </div>
                <ExpenseCustomFieldFilters
                  fields={filterableCustomFields}
                  values={customFieldFilters}
                  onChange={setCustomFieldFilters}
                  className="pt-2"
                />
              </div>

              <ReportLiveRefreshBar query={approvalQuery} />
              {approvalQuery.isLoading ? null : filteredApprovalExpenses.length === 0 ? (
                <div className="py-8 text-center text-slate-500 text-sm">No expenses found</div>
              ) : isMobile ? (
                <div className="space-y-2" data-testid="approval-card-list">
                  {filteredApprovalExpenses.map(exp => (
                    <div key={exp.id} className="rounded-md border p-3 space-y-1" data-testid="approval-expense-card">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm">{exp.user_name}</span>
                        <span className="text-sm font-medium">{formatINR(Number(exp.total_amount || 0))}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {exp.title || "-"}{exp.category ? ` · ${exp.category}` : ""}
                      </div>
                      {approvalCustomKeys.filter((k) => exp.custom_fields?.[k]).map((k) => (
                        <div key={k} className="text-xs text-muted-foreground truncate">
                          <span className="font-medium">{k}:</span> {exp.custom_fields![k]}
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <StatusBadge status="verified" />
                        <StatusBadge status="approved" />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{formatDateDDMMYYYY(exp.created_at)}</span>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => navigate(`/expenses/${exp.id}`)}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 border-b">
                      <tr>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee ID</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Transaction #</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Title</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Purpose</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.destination")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.tripEnd")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.batch")}</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Expense Type</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">LPO Number</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Bill Date (DD-MM-YYYY)</th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Bill Amount</th>
                        {approvalCustomKeys.map((k) => (
                          <th key={k} className="px-4 py-3 text-left font-semibold text-slate-700 whitespace-nowrap">{k}</th>
                        ))}
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Opening Balance</th>
                        <th className="px-4 py-3 text-right font-semibold text-slate-700">Closing Balance</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Manager Approval</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">HO Approval</th>
                        <th className="px-4 py-3 text-left font-semibold text-slate-700">Submitted On (DD-MM-YYYY)</th>
                        <th className="px-4 py-3 text-center font-semibold text-slate-700">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredApprovalExpenses.map(exp => (
                        <tr key={exp.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3">{exp.user_name}</td>
                          <td className="px-4 py-3 text-slate-500 font-mono text-xs">{exp.employee_id || "-"}</td>
                          <td className="px-4 py-3">{exp.transaction_number || "-"}</td>
                          <td className="px-4 py-3 max-w-[140px] truncate" title={exp.title || ""}>{exp.title || "-"}</td>
                          <td className="px-4 py-3 max-w-[160px] truncate" title={exp.purpose || ""}>{exp.purpose || "-"}</td>
                          <td className="px-4 py-3 max-w-[120px] truncate" title={exp.destination || ""}>{exp.destination || "-"}</td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.trip_end)}</td>
                          <td className="px-4 py-3 max-w-[120px] truncate" title={exp.batch_ref}>{exp.batch_ref}</td>
                          <td className="px-4 py-3">{exp.category || "-"}</td>
                          <td className="px-4 py-3">-</td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.trip_start)}</td>
                          <td className="px-4 py-3 text-right font-medium">{formatINR(Number(exp.total_amount || 0))}</td>
                          {approvalCustomKeys.map((k) => (
                            <td key={k} className="px-4 py-3 max-w-[140px] truncate text-sm" title={exp.custom_fields?.[k] ?? ""}>
                              {exp.custom_fields?.[k] ?? ""}
                            </td>
                          ))}
                          <td className="px-4 py-3 text-right text-sm">{formatINR(approvalRowBalances.get(exp.id)?.opening ?? 0)}</td>
                          <td className="px-4 py-3 text-right text-sm font-medium">{formatINR(approvalRowBalances.get(exp.id)?.closing ?? 0)}</td>
                          <td className="px-4 py-3">
                            <StatusBadge status="verified" />
                          </td>
                          <td className="px-4 py-3">
                            <StatusBadge status="approved" />
                          </td>
                          <td className="px-4 py-3">{formatDateDDMMYYYY(exp.created_at)}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-center gap-2">
                              <Button variant="ghost" size="sm" onClick={() => navigate(`/expenses/${exp.id}`)}>
                                <Eye className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => navigate(`/expenses/${exp.id}`)}>
                                <FileText className="h-4 w-4" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Detailed Expense Report */}
        <TabsContent value="detailed" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Detailed Expense Report</CardTitle>
              <CardDescription>Approved expenses only, with balance tracking</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <Label className="text-sm font-semibold">FILTERS</Label>

                <div className="space-y-2">
                  <Label>Employee</Label>
                  <Select value={selectedEmployee} onValueChange={handleDetailedEmployeeChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="All employees" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All employees</SelectItem>
                      {users.map((u) => (
                        <SelectItem key={u.user_id} value={u.user_id}>
                          {formatReportUserLabel(u)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Leave as All employees to filter across everyone. Select one employee for wallet balance tracking.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Expense Type</Label>
                    <Select value={selectedCategory} onValueChange={setSelectedCategory}>
                      <SelectTrigger>
                        <SelectValue placeholder="All categories" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All categories</SelectItem>
                        {categories.map((c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Year</Label>
                    <Select value={selectedYear} onValueChange={setSelectedYear}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - i).map((year) => (
                          <SelectItem key={year} value={year.toString()}>
                            {year}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Month</Label>
                    <Select value={selectedMonth} onValueChange={setSelectedMonth}>
                      <SelectTrigger>
                        <SelectValue placeholder="All months" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All months</SelectItem>
                        {Array.from({ length: 12 }, (_, i) => {
                          const month = new Date(2000, i, 1).toLocaleString("default", {
                            month: "long",
                          });
                          return (
                            <SelectItem key={i + 1} value={(i + 1).toString()}>
                              {month}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Week</Label>
                    <Select value={selectedWeek} onValueChange={setSelectedWeek}>
                      <SelectTrigger>
                        <SelectValue placeholder="All weeks" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All weeks</SelectItem>
                        {Array.from({ length: 52 }, (_, i) => (
                          <SelectItem key={i + 1} value={(i + 1).toString()}>
                            Week {i + 1}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <ExpenseCustomFieldFilters
                  fields={detailedCustomFilterFields}
                  values={customFieldFilters}
                  onChange={setCustomFieldFilters}
                  filledValuesByField={
                    selectedEmployee === "all" ? undefined : employeeFilledSets
                  }
                  className="pt-1"
                  hint={
                    selectedEmployee === "all"
                      ? "Options include every value used on approved expenses in the selected period (all employees)."
                      : "Options in red have no approved expenses for this employee in the selected period."
                  }
                  emptyMessage="No dropdown or checkbox custom fields are configured yet. Add them under Categories → Form fields."
                />
                {loadingEmployeeFieldOptions && (
                  <p className="text-xs text-muted-foreground">Loading custom field options…</p>
                )}

                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={() => void detailedQuery.refetch()}
                    disabled={detailedQuery.isFetching || loadingEmployeeFieldOptions}
                  >
                    Submit
                  </Button>
                  <Button variant="outline" onClick={clearFilters}>
                    Clear
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => openExportDialog("detailed")}
                    disabled={detailedQuery.isFetching || filteredDetailedExpenses.length === 0}
                    title={detailedQuery.isFetching ? t("liveRefresh.exportWait") : undefined}
                  >
                    Export
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.print()}
                    disabled={detailedQuery.isFetching || filteredDetailedExpenses.length === 0}
                    className="print:inline-flex print:visible"
                  >
                    <Printer className="h-4 w-4 mr-2" />
                    Print report
                  </Button>
                </div>
              </div>

              <div className="space-y-2 p-4 bg-slate-50 rounded-lg">
                <p className="font-semibold">
                  {selectedUser ? selectedUser.name : "All employees"}
                </p>
                <p className="text-sm text-slate-600">Year : {selectedYear.slice(-2)}</p>
              </div>

              <ReportLiveRefreshBar query={detailedQuery} />
              <div className="space-y-4">
                <div>
                  <h3 className="text-lg font-semibold mb-2">Detailed List</h3>
                  {isMobile ? (
                    <MobileDetailedExpenseReportView
                      showDetailedBalanceColumns={showDetailedBalanceColumns}
                      loading={detailedQuery.isLoading}
                      detailedCustomFilterHasNoData={detailedCustomFilterHasNoData}
                      balanceInfo={balanceInfo}
                      detailedListWithBalances={detailedListWithBalances}
                      detailedAllEmployeesRows={detailedAllEmployeesRows}
                    />
                  ) : (
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-100 border-b">
                        <tr>
                          {!showDetailedBalanceColumns && (
                            <>
                              <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee</th>
                              <th className="px-4 py-3 text-left font-semibold text-slate-700">Employee ID</th>
                            </>
                          )}
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Bill Date</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Title</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Type of Expense</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Purpose</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Destination</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">{t("columns.batch")}</th>
                          {detailedCustomKeys.map((k) => (
                            <th key={k} className="px-4 py-3 text-left font-semibold text-slate-700 whitespace-nowrap">{k}</th>
                          ))}
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">Credit</th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">Debit</th>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Notes</th>
                          {showDetailedBalanceColumns && (
                            <>
                              <th className="px-4 py-3 text-right font-semibold text-slate-700">Opening Balance</th>
                              <th className="px-4 py-3 text-right font-semibold text-slate-700">Closing Balance</th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {showDetailedBalanceColumns && (
                          <tr className="bg-slate-50 font-medium">
                            <td className="px-4 py-3" colSpan={6 + detailedCustomKeys.length + 2}></td>
                            <td className="px-4 py-3">Opening Balance</td>
                            <td className="px-4 py-3 text-right font-medium">{formatINR(balanceInfo.opening)}</td>
                            <td className="px-4 py-3 text-right font-medium">{formatINR(balanceInfo.opening)}</td>
                          </tr>
                        )}
                        {showDetailedBalanceColumns ? (
                          detailedListWithBalances.length === 0 ? (
                            <tr>
                              <td
                                colSpan={11 + detailedCustomKeys.length}
                                className="px-4 py-6 text-center text-slate-500"
                              >
                                {detailedCustomFilterHasNoData
                                  ? "No approved expenses for this employee with the selected custom field value (red options have no data)."
                                  : "No allocations or expenses in this period. Click Submit after choosing filters."}
                              </td>
                            </tr>
                          ) : (
                            detailedListWithBalances.map((row) => (
                              <tr key={row.id} className="hover:bg-slate-50">
                                <td className="px-4 py-3">{formatDateDDMMYYYY(row.date)}</td>
                                <td className="px-4 py-3 max-w-[120px] truncate" title={row.type === "expense" ? row.title : ""}>
                                  {row.type === "expense" ? row.title || "-" : "-"}
                                </td>
                                <td className="px-4 py-3">{row.category}</td>
                                <td className="px-4 py-3">{row.purpose ?? "-"}</td>
                                <td className="px-4 py-3">{row.destination ?? "-"}</td>
                                <td className="px-4 py-3 max-w-[120px] truncate" title={row.batchRef}>
                                  {row.batchRef}
                                </td>
                                {detailedCustomKeys.map((k) => (
                                  <td
                                    key={k}
                                    className="px-4 py-3 max-w-[140px] truncate text-sm"
                                    title={row.type === "expense" ? row.customFields?.[k] ?? "" : ""}
                                  >
                                    {row.type === "expense" ? row.customFields?.[k] ?? "" : ""}
                                  </td>
                                ))}
                                <td className="px-4 py-3 text-right font-medium">
                                  {row.credit > 0 ? formatINR(row.credit) : ""}
                                </td>
                                <td className="px-4 py-3 text-right font-medium">
                                  {row.debit > 0 ? formatINR(row.debit) : ""}
                                </td>
                                <td className="px-4 py-3">{row.notes}</td>
                                <td className="px-4 py-3 text-right">{formatINR(row.openingBalance)}</td>
                                <td className="px-4 py-3 text-right font-medium">
                                  {formatINR(row.closingBalance)}
                                </td>
                              </tr>
                            ))
                          )
                        ) : detailedAllEmployeesRows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={10 + detailedCustomKeys.length}
                              className="px-4 py-6 text-center text-slate-500"
                            >
                              No approved expenses match your filters. Click Submit to refresh, or widen year/month/category.
                            </td>
                          </tr>
                        ) : (
                          detailedAllEmployeesRows.map((exp) => (
                            <tr key={exp.id} className="hover:bg-slate-50">
                              <td className="px-4 py-3">{exp.user_name}</td>
                              <td className="px-4 py-3 text-slate-500 font-mono text-xs">{exp.employee_id || "-"}</td>
                              <td className="px-4 py-3">{formatDateDDMMYYYY(exp.trip_start)}</td>
                              <td className="px-4 py-3 max-w-[120px] truncate" title={exp.title ?? ""}>
                                {exp.title || "-"}
                              </td>
                              <td className="px-4 py-3">{exp.category ?? "-"}</td>
                              <td className="px-4 py-3">{exp.purpose ?? "-"}</td>
                              <td className="px-4 py-3">{exp.destination ?? "-"}</td>
                              <td className="px-4 py-3 max-w-[120px] truncate" title={exp.batch_ref}>
                                {exp.batch_ref}
                              </td>
                              {detailedCustomKeys.map((k) => (
                                <td
                                  key={k}
                                  className="px-4 py-3 max-w-[140px] truncate text-sm"
                                  title={exp.custom_fields?.[k] ?? ""}
                                >
                                  {exp.custom_fields?.[k] ?? ""}
                                </td>
                              ))}
                              <td className="px-4 py-3 text-right font-medium"></td>
                              <td className="px-4 py-3 text-right font-medium">
                                {formatINR(Number(exp.total_amount || 0))}
                              </td>
                              <td className="px-4 py-3">{exp.purpose || "-"}</td>
                            </tr>
                          ))
                        )}
                        {showDetailedBalanceColumns &&
                          !detailedQuery.isLoading &&
                          detailedListWithBalances.length > 0 && (
                            <tr className="bg-slate-50 font-medium">
                              <td className="px-4 py-3" colSpan={6 + detailedCustomKeys.length + 2}></td>
                              <td className="px-4 py-3">Closing Balance</td>
                              <td className="px-4 py-3 text-right font-medium">
                                {formatINR(
                                  detailedListWithBalances[detailedListWithBalances.length - 1]
                                    .closingBalance,
                                )}
                              </td>
                              <td className="px-4 py-3 text-right font-medium">
                                {formatINR(
                                  detailedListWithBalances[detailedListWithBalances.length - 1]
                                    .closingBalance,
                                )}
                              </td>
                            </tr>
                          )}
                      </tbody>
                    </table>
                  </div>
                  )}
                </div>

                <div>
                  <h3 className="text-lg font-semibold mb-2">Summary</h3>
                  <div className="overflow-x-auto border rounded-lg">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-100 border-b">
                        <tr>
                          <th className="px-4 py-3 text-left font-semibold text-slate-700">Type of Expense</th>
                          <th className="px-4 py-3 text-right font-semibold text-slate-700">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {totalAllocationsInPeriod > 0 && (
                          <tr className="hover:bg-slate-50">
                            <td className="px-4 py-3">Account Credited</td>
                            <td className="px-4 py-3 text-right font-medium">{formatINR(totalAllocationsInPeriod)}</td>
                          </tr>
                        )}
                        {totalReturnsInPeriod > 0 && (
                          <tr className="hover:bg-slate-50">
                            <td className="px-4 py-3">Money Returned</td>
                            <td className="px-4 py-3 text-right font-medium">{formatINR(totalReturnsInPeriod)}</td>
                          </tr>
                        )}
                        {Object.entries(detailedSummary).map(([category, amount]) => (
                          <tr key={category} className="hover:bg-slate-50">
                            <td className="px-4 py-3">{category}</td>
                            <td className="px-4 py-3 text-right font-medium">{formatINR(amount)}</td>
                          </tr>
                        ))}
                        <tr className="bg-slate-200 font-bold border-t-2">
                          <td className="px-4 py-3">Total</td>
                          <td className="px-4 py-3 text-right">{formatINR(totalAmount)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {dailyProjectReportEnabled && (
          <TabsContent value="daily" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("daily.title")}</CardTitle>
                <CardDescription>{t("daily.description")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {!dailyConfigReady ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                    {t("daily.configRequiredHint")}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label className="text-sm font-semibold">{t("daily.filters")}</Label>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-2">
                      <Label>Period</Label>
                      <Select
                        value={dailyPeriodMode}
                        onValueChange={(v) => setDailyPeriodMode(v as DailyPeriodMode)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all_time">All time</SelectItem>
                          <SelectItem value="custom">Date range</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {!dailyAllTime && (
                      <>
                        <div className="space-y-2">
                          <Label>{t("from")}</Label>
                          <Input
                            type="date"
                            value={dailyDateFrom}
                            onChange={(e) => setDailyDateFrom(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>{t("to")}</Label>
                          <Input
                            type="date"
                            value={dailyDateTo}
                            onChange={(e) => setDailyDateTo(e.target.value)}
                          />
                        </div>
                      </>
                    )}
                    <div className="space-y-2">
                      <Label>Employee</Label>
                      <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
                        <SelectTrigger>
                          <SelectValue placeholder="All employees" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All employees</SelectItem>
                          {users.map((u) => (
                            <SelectItem key={u.user_id} value={u.user_id}>
                              {formatReportUserLabel(u)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex gap-2 pt-2">
                    <Button
                      onClick={() => void dailyQuery.refetch()}
                      disabled={dailyQuery.isFetching || !dailyConfigReady}
                    >
                      {dailyQuery.isFetching ? t("daily.generating") : t("generate")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => exportDailyProjectReport("csv")}
                      disabled={dailyQuery.isFetching || !dailyConfigReady || dailyReportRows.length === 0}
                      title={dailyQuery.isFetching ? t("liveRefresh.exportWait") : undefined}
                    >
                      {t("exportCsv")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => exportDailyProjectReport("xlsx")}
                      disabled={dailyQuery.isFetching || !dailyConfigReady || dailyReportRows.length === 0}
                      title={dailyQuery.isFetching ? t("liveRefresh.exportWait") : undefined}
                    >
                      {t("exportXlsx")}
                    </Button>
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  {t("daily.rowCount", { count: dailyReportRows.length })}
                  {dailyReviewRowCount > 0 ? (
                    <span className="ml-2 text-xs font-medium text-amber-700">
                      {t("daily.reviewCount", { count: dailyReviewRowCount })}
                    </span>
                  ) : null}
                  {dailyQuery.isFetching ? (
                    <span className="ml-2 text-xs text-muted-foreground" data-testid="daily-progress">
                      (
                      {dailyProgress && dailyProgress.total != null
                        ? t("daily.preparingProgress", {
                            received: dailyProgress.received,
                            total: dailyProgress.total,
                          })
                        : t("daily.generating")}
                      )
                    </span>
                  ) : null}
                </p>

                {/* A failed export must never look like an empty-but-successful
                    one: say plainly that no file was produced (DOC-101). */}
                {!dailyQuery.isFetching && dailyQuery.error ? (
                  <p
                    className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-md px-3 py-2"
                    data-testid="daily-report-error"
                  >
                    {dailyQuery.error instanceof DailyReportExportError
                      ? t(`daily.errors.${dailyQuery.error.code}`, {
                          defaultValue: t("daily.errors.generic"),
                        })
                      : t("daily.errors.generic")}
                  </p>
                ) : null}

                {dailyReviewRowCount > 0 ? (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    {t("daily.reviewHint")}
                  </p>
                ) : null}

                {dailyReportRows.length > 0 ? (
                  <p className="text-xs text-muted-foreground">{t("daily.clickRowHint")}</p>
                ) : null}

                <ReportLiveRefreshBar query={dailyQuery} />
                {isMobile ? (
                  <div className="space-y-2" data-testid="daily-report-card-list">
                    {dailyQuery.isLoading ? null : dailyReportRows.length === 0 ? (
                      <div className="py-8 text-center text-slate-500 text-sm">{t("daily.noRows")}</div>
                    ) : (
                      dailyReportResults.map((result, idx) => {
                        const row = result.row;
                        const needsReview = isDailyReportRowNeedsReview(row);
                        return (
                          <button
                            key={idx}
                            type="button"
                            className={`w-full text-left rounded-md border p-3 space-y-1 ${needsReview ? "bg-amber-50 border-l-4 border-l-amber-400" : "hover:bg-slate-50"}`}
                            onClick={() => {
                              setSelectedDailyReportResult(result);
                              setDailyReportSourceOpen(true);
                            }}
                            data-testid="daily-report-card"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs text-muted-foreground">{String(row["Track Date"] ?? "-")}</span>
                              <span className="text-sm font-medium truncate">{String(row["Employee"] ?? "-")}</span>
                            </div>
                            <div className="text-xs truncate text-muted-foreground">{String(row["project name"] ?? "-")}</div>
                          </button>
                        );
                      })
                    )}
                  </div>
                ) : (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 border-b">
                      <tr>
                        {DAILY_PROJECT_REPORT_HEADERS.map((h) => (
                          <th
                            key={h}
                            className="px-3 py-2 text-left font-semibold text-slate-700 whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {dailyQuery.isLoading ? (
                        <tr>
                          <td
                            colSpan={DAILY_PROJECT_REPORT_HEADERS.length}
                            className="px-4 py-8 text-center text-slate-500"
                          >
                            {t("daily.generatingReport")}
                          </td>
                        </tr>
                      ) : dailyReportRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={DAILY_PROJECT_REPORT_HEADERS.length}
                            className="px-4 py-8 text-center text-slate-500"
                          >
                            {t("daily.noRows")}
                          </td>
                        </tr>
                      ) : (
                        dailyReportResults.map((result, idx) => {
                          const row = result.row;
                          const needsReview = isDailyReportRowNeedsReview(row);
                          return (
                          <tr
                            key={idx}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              setSelectedDailyReportResult(result);
                              setDailyReportSourceOpen(true);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setSelectedDailyReportResult(result);
                                setDailyReportSourceOpen(true);
                              }
                            }}
                            className={
                              needsReview
                                ? "bg-amber-50 hover:bg-amber-100 border-l-4 border-l-amber-400 cursor-pointer"
                                : "hover:bg-slate-100 cursor-pointer"
                            }
                          >
                            {DAILY_PROJECT_REPORT_HEADERS.map((h) => (
                              <td
                                key={h}
                                className={`px-3 py-2 whitespace-nowrap ${
                                  needsReview &&
                                  (h === "project id" || h === "project name") &&
                                  !String(row[h] ?? "").trim()
                                    ? "text-amber-900 font-medium"
                                    : ""
                                }`}
                              >
                                {typeof row[h] === "number"
                                  ? Number(row[h]).toLocaleString("en-IN")
                                  : String(row[h] ?? "")}
                              </td>
                            ))}
                          </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <DailyReportSourceExpensesSheet
        open={dailyReportSourceOpen}
        onOpenChange={setDailyReportSourceOpen}
        result={selectedDailyReportResult}
      />

      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export report</DialogTitle>
            <DialogDescription>
              Choose the format for your export. The{" "}
              {exportTab === "verification"
                ? "Claim Verification"
                : exportTab === "approval"
                  ? "Claim Approval"
                  : exportTab === "daily"
                    ? t("daily.tabTitle")
                    : "Detailed Expense"}{" "}
              report will be downloaded.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-4">
            <Button variant="outline" className="h-auto flex flex-col items-center gap-2 py-4" onClick={() => handleExportAs("xlsx")}>
              <FileSpreadsheet className="h-8 w-8 text-green-600" />
              <span>XLSX</span>
              <span className="text-xs text-muted-foreground font-normal">Excel spreadsheet</span>
            </Button>
            <Button variant="outline" className="h-auto flex flex-col items-center gap-2 py-4" onClick={() => handleExportAs("csv")}>
              <FileText className="h-8 w-8 text-slate-600" />
              <span>CSV</span>
              <span className="text-xs text-muted-foreground font-normal">Comma-separated values</span>
            </Button>
            {exportTab !== "daily" && (
              <>
                <Button variant="outline" className="h-auto flex flex-col items-center gap-2 py-4" onClick={() => handleExportAs("json")}>
                  <FileJson className="h-8 w-8 text-amber-600" />
                  <span>JSON</span>
                  <span className="text-xs text-muted-foreground font-normal">Structured data</span>
                </Button>
                <Button variant="outline" className="h-auto flex flex-col items-center gap-2 py-4" onClick={() => handleExportAs("pdf")}>
                  <FileType className="h-8 w-8 text-red-600" />
                  <span>PDF</span>
                  <span className="text-xs text-muted-foreground font-normal">Portable document</span>
                </Button>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setExportDialogOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
