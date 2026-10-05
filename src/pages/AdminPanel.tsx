import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  Users,
  Receipt,
  CheckCircle,
  XCircle,
  Clock,
  Coins,
  Eye,
  UserPlus,
  Settings,
  TrendingUp,
  Filter,
  Search,
  Download,
  Database,
  RotateCcw,
  ExternalLink
} from "lucide-react";
import { fetchOrgBackup, downloadBackup, downloadBackupWithReceipts, fetchReceiptBlobs } from "@/lib/backupData";
import { useToast } from "@/hooks/use-toast";
import { ExpenseService } from "@/services/ExpenseService";
import { format } from "date-fns";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { MobileExpenseTable } from "@/components/MobileExpenseTable";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";
import { serializeCsv, formatCsvDate, formatCsvTimestamp } from "@/lib/csv";
import { ADMIN_APPROVABLE_STATUSES, isAdminApprovableStatus } from "@/lib/approvalHierarchy";
import { getDateLocale } from "@/lib/formatLocale";
import { ExpenseCorrectionAuditList } from "@/components/ExpenseCorrectionAudit";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";
import { SubmitExpenseActions } from "@/components/SubmitExpenseActions";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { ExpenseBaseFieldsDisplay } from "@/components/ExpenseBaseFieldsDisplay";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import { enrichAuditLogsWithDisplay, type EnrichedAuditLog } from "@/lib/auditLogDisplay";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { expenseRowMatchesSearch } from "@/lib/expenseListSearch";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { AttachmentThumbnail } from "@/components/AttachmentThumbnail";
import { normalizeReceiptPublicUrl } from "@/lib/attachmentPreview";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import { AdminExpenseImportPanel } from "@/components/AdminExpenseImportPanel";
import { fetchExpenseCustomFieldsMap, matchesCustomFieldFilters } from "@/lib/expenseCustomFieldFilters";
import { fetchExpenseSubmitterProfiles, fetchProfilesByUserIds, fetchResubmittedExpenseIds } from "@/lib/supabaseInQuery";
import { formatApiError } from "@/lib/formatApiError";
import { useExpenseCustomFieldFilters } from "@/hooks/useExpenseCustomFieldFilters";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileAdminExpensesView } from "@/components/mobile/MobileAdminExpensesView";
import { MobileAdminExpenseDetailView } from "@/components/mobile/MobileAdminExpenseDetailView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import {
  loadCorrectionCustomFields,
  validateCorrectionCustomFields,
  fetchCorrectionOptionBranches,
  mergeCorrectionOptionBranches,
  type CorrectionCustomFieldsModel,
  EMPTY_CORRECTION_FIELDS,
} from "@/lib/loadCorrectionCustomFields";
import { buildCorrectionCustomFieldPatch } from "@/lib/buildCorrectionCustomFieldPatch";
import { CorrectionCustomFieldsSection } from "@/components/CorrectionCustomFieldsSection";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  created_at: string;
  is_active: boolean;
  balance?: number | null;
  reporting_engineer_id?: string | null;
}

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
}

interface Expense {
  id: string;
  title: string;
  destination: string;
  trip_start: string;
  trip_end: string;
  status: string;
  total_amount: number;
  created_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_employee_id: string;
  user_balance: number;
  assigned_engineer_id?: string;
  assigned_reviewer_id?: string;
  approval_tier?: string | null;
  updated_at?: string;
  admin_comment?: string;
  isResubmitted?: boolean;
  category?: string | null;
  purpose?: string | null;
  transaction_number?: string | null;
  wasReviewerCorrected?: boolean;
  batch_id?: string | null;
  custom_fields?: Record<string, string>;
}

export default function AdminPanel() {
  const { t, i18n } = useTranslation(["admin", "common", "expenses"]);
  const navigate = useNavigate();
  const { user, userRole, organizationId, organizationFeatureFlags, hasOrganizationFeature } =
    useAuth();
  const { roleLabels } = useOrganizationRoleLabels();
  const { getFieldLabel: getBaseFieldLabel } = useOrganizationExpenseFormConfig(organizationId);
  const hierarchyEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
  );
  const teamLeaderTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader]);
  const executiveTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_executive]);
  const employeeIdLoginEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.employee_id_login,
  );
  const { expenseSearchIdentityOptions } = useOrganizationIdentityMode();
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;
  const {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
  } = useExpenseCustomFieldFilters(organizationId);
  const { toast } = useToast();
  const moneyLocale = getDateLocale(i18n.language);
  const { isMobile } = useViewportMode();

  const [users, setUsers] = useState<User[]>([]);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [previewContentType, setPreviewContentType] = useState<string | null>(null);
  const [previewUploadedBy, setPreviewUploadedBy] = useState<string | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [expensesLoading, setExpensesLoading] = useState(true);
  const [expensesEnriching, setExpensesEnriching] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  /** Live row from expenses list (includes async custom_fields enrichment). */
  const reviewExpense = useMemo(() => {
    if (!selectedExpense) return null;
    return expenses.find((e) => e.id === selectedExpense.id) ?? selectedExpense;
  }, [selectedExpense, expenses]);
  const [adminComment, setAdminComment] = useState("");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [selectedEngineer, setSelectedEngineer] = useState("");
  const [engineers, setEngineers] = useState<User[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [correctionLogs, setCorrectionLogs] = useState<ExpenseCorrectionLogEntry[]>([]);
  const [correctionReason, setCorrectionReason] = useState("");
  const [corrFieldModel, setCorrFieldModel] = useState<CorrectionCustomFieldsModel>(EMPTY_CORRECTION_FIELDS);
  const [corrTitle, setCorrTitle] = useState("");
  const [corrDestination, setCorrDestination] = useState("");
  /** Single expense date (same as employee form); stored as trip_start + trip_end in DB. */
  const [corrExpenseDate, setCorrExpenseDate] = useState("");
  const [corrPurpose, setCorrPurpose] = useState("");
  const [corrCategory, setCorrCategory] = useState("");
  const [corrAmount, setCorrAmount] = useState("");
  const [corrAdminComment, setCorrAdminComment] = useState("");
  const [auditLogs, setAuditLogs] = useState<EnrichedAuditLog[]>([]);
  const [timelineAssignees, setTimelineAssignees] = useState<{
    reviewer?: string | null;
    engineer?: string | null;
  }>({});
  const reviewDialogContentRef = useRef<HTMLDivElement>(null);
  // Monotonic token: only the most recent fetchExpenses() may write to state,
  // so a slower/older request (or its async enrichment) can never revert the list.
  const expensesFetchSeqRef = useRef(0);
  const [backupLoading, setBackupLoading] = useState(false);
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const filterMountedRef = useRef(false);
  const [currentPage, setCurrentPage] = useState(
    () => Math.max(1, parseInt(sessionStorage.getItem("pesowise:admin-expenses-page") ?? "1", 10) || 1),
  );
  const [totalExpenseCount, setTotalExpenseCount] = useState(0);
  const [allExpensesLoaded, setAllExpensesLoaded] = useState(
    () => sessionStorage.getItem("pesowise:load-all:admin") === "true",
  );
  const [loadingAllExpenses, setLoadingAllExpenses] = useState(false);

  const [hasCompletedExpenseFetch, setHasCompletedExpenseFetch] = useState(false);
  const [expenseFetchError, setExpenseFetchError] = useState<string | null>(null);

  const {
    progress: expenseFetchProgress,
    startOperation: startExpenseFetch,
    completeOperation: completeExpenseFetch,
    failOperation: failExpenseFetch,
    resetOperation: resetExpenseFetch,
  } = useOperationProgress();

  const {
    progress: loadAllProgress,
    startOperation: startLoadAll,
    updateOperation: updateLoadAll,
    completeOperation: completeLoadAll,
    failOperation: failLoadAll,
    resetOperation: resetLoadAll,
  } = useOperationProgress();

  const {
    progress: bulkProgress,
    startOperation: startBulkOp,
    updateOperation: updateBulkOp,
    completeOperation: completeBulkOp,
    failOperation: failBulkOp,
  } = useOperationProgress();

  const [expenseSortBy, setExpenseSortBy] = useState<"created_at" | "trip_start" | "user_name">("created_at");
  const [expenseSortOrder, setExpenseSortOrder] = useState<"asc" | "desc">("desc");
  const EXPENSES_PER_PAGE = 15;
  const EXPENSE_INITIAL_FETCH_LIMIT = 150;
  const EXPENSE_FETCH_PAGE_SIZE = 1000;

  useEffect(() => {
    if (userRole === "admin" && organizationId) {
      fetchData();
    }
  }, [userRole, organizationId, user?.id]);

  // Fix blank white page: scroll review dialog content to top when opened
  useEffect(() => {
    if (dialogOpen && selectedExpense) {
      const scrollEl = reviewDialogContentRef.current;
      if (scrollEl) {
        const scrollToTop = () => { scrollEl.scrollTop = 0; };
        scrollToTop();
        requestAnimationFrame(scrollToTop);
        const t = setTimeout(scrollToTop, 50);
        return () => clearTimeout(t);
      }
    }
  }, [dialogOpen, selectedExpense?.id]);


  const fetchData = async () => {
    try {
      setLoading(true);
      const results = await Promise.allSettled([
        fetchUsers(),
        fetchExpenses(),
        fetchEngineers(),
      ]);
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      if (failures.length > 0) {
        toast({
          variant: "destructive",
          title: t("admin:panel.toast.loadExpensesFailed"),
          description: formatApiError(
            failures[0]?.reason,
            t("admin:panel.toast.loadExpensesFailedHint"),
          ),
        });
      }
    } catch (error) {
      console.error("[AdminPanel] Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchAttachments = async (expenseId: string) => {
    try {
      if (!organizationId) return;

      const { data, error } = await supabase
        .from("attachments")
        .select("id, filename, content_type, file_url, created_at")
        .eq("expense_id", expenseId)
        .eq("organization_id", organizationId)
        .order("created_at");

      if (error) throw error;

      const normalized = (data || []).map((a) => ({
        ...a,
        file_url: normalizeReceiptPublicUrl(a.file_url || ""),
      }));

      setAttachments(normalized);
    } catch (e) {
      console.error("Error fetching attachments:", e);
      setAttachments([]);
    }
  };

  const fetchAuditLogs = async (expenseId: string, expenseRow?: Expense | null) => {
    try {
      if (!organizationId) return;

      const { data: logsData, error: logsError } = await supabase
        .from("audit_logs")
        .select("user_id, action, comment, created_at")
        .eq("expense_id", expenseId)
        .order("created_at", { ascending: true });

      if (logsError) throw logsError;

      setAuditLogs(await enrichAuditLogsWithDisplay(logsData || []));

      const expenseForTimeline = expenseRow ?? selectedExpense;
      const assigneeIds = [
        expenseForTimeline?.assigned_reviewer_id,
        expenseForTimeline?.assigned_engineer_id,
      ].filter((id): id is string => Boolean(id));

      if (assigneeIds.length > 0) {
        const { data: assigneeProfiles } = await supabase
          .from("profiles")
          .select("user_id, name")
          .in("user_id", assigneeIds);
        const nameById = new Map(
          (assigneeProfiles ?? []).map((p) => [
            p.user_id,
            p.name?.trim() || "Unknown user",
          ]),
        );
        setTimelineAssignees({
          reviewer: expenseForTimeline?.assigned_reviewer_id
            ? nameById.get(expenseForTimeline.assigned_reviewer_id) ?? null
            : null,
          engineer: expenseForTimeline?.assigned_engineer_id
            ? nameById.get(expenseForTimeline.assigned_engineer_id) ?? null
            : null,
        });
      } else {
        setTimelineAssignees({});
      }
    } catch (error) {
      console.error("Error fetching audit logs:", error);
      setAuditLogs([]);
      setTimelineAssignees({});
    }
  };

  const fetchCorrectionLogs = async (expenseId: string) => {
    if (!user?.id) return;
    try {
      const rows = await ExpenseService.listExpenseCorrectionLogs(expenseId, user.id);
      const editorIds = [...new Set(rows.map((r) => r.edited_by))];
      if (editorIds.length === 0) {
        setCorrectionLogs(rows);
        return;
      }
      const { data: editorProfiles } = await supabase
        .from("profiles")
        .select("user_id, name")
        .in("user_id", editorIds);
      const editorNames = new Map(
        (editorProfiles ?? []).map((p) => [
          p.user_id,
          p.name?.trim() || "Unknown user",
        ]),
      );
      setCorrectionLogs(
        rows.map((r) => ({
          ...r,
          edited_by: editorNames.get(r.edited_by) ?? r.edited_by,
        })),
      );
    } catch {
      setCorrectionLogs([]);
    }
  };

  const correctionsFeatureEnabled = Boolean(
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_manager_admin_expense_corrections],
  );

  const canReviewerCorrectExpense = (exp: Expense | null) => {
    if (!exp || !user) return false;
    if (!correctionsFeatureEnabled) return false;
    if (exp.user_id === user.id) return false;
    return ["submitted", "verified", "under_review", "rejected", "edited"].includes(exp.status);
  };

  const openCorrectionDialog = async () => {
    if (!selectedExpense) return;
    setCorrTitle(selectedExpense.title);
    setCorrDestination(selectedExpense.destination);
    const dateSrc = selectedExpense.trip_start || selectedExpense.trip_end;
    setCorrExpenseDate(dateSrc ? String(dateSrc).slice(0, 10) : "");
    setCorrPurpose(selectedExpense.purpose ?? "");
    setCorrCategory(selectedExpense.category ?? "");
    setCorrAmount(String(selectedExpense.total_amount ?? ""));
    setCorrAdminComment(selectedExpense.admin_comment ?? "");
    setCorrectionReason("");
    setCorrFieldModel({ ...EMPTY_CORRECTION_FIELDS });

    if (selectedExpense.category && organizationId) {
      const model = await loadCorrectionCustomFields(
        supabase,
        organizationId,
        selectedExpense.id,
        selectedExpense.category,
      );
      setCorrFieldModel(model);
    }

    setCorrectionDialogOpen(true);
  };

  /** DOC-100 pt.2: the reviewer changing a parent select's value mid-correction
   *  must load that option's tree on demand -- the initial load only ever
   *  fetched whichever value was SAVED when the dialog opened. */
  const handleCorrectionSelectOptionValue = async (templateId: string, optionValue: string) => {
    if (!organizationId || !optionValue) return;
    const result = await fetchCorrectionOptionBranches(supabase, organizationId, templateId, optionValue);
    setCorrFieldModel((prev) => ({
      ...prev,
      optionBranches: mergeCorrectionOptionBranches(prev.optionBranches, templateId, result.branches),
      loadError: result.error
        ? "Could not load additional field configuration for the selected option. Please retry."
        : undefined,
    }));
  };

  const submitExpenseCorrection = async () => {
    if (!selectedExpense || !user) return;
    setCorrectionLoading(true);
    try {
      const amt = Number(corrAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new Error("Amount must be a positive number");
      }

      if (corrFieldModel.loadError) {
        throw new Error(corrFieldModel.loadError);
      }

      const vResult = validateCorrectionCustomFields(
        corrFieldModel.categoryFormFields,
        corrFieldModel.formFieldValues,
        corrFieldModel.optionBranches,
        corrFieldModel.branchValues,
        allowNestedConditional,
      );
      if (!vResult.ok) throw new Error(vResult.message);

      const visibleBranchIds = getVisibleBranchIds(
        corrFieldModel.optionBranches,
        corrFieldModel.formFieldValues,
        corrFieldModel.branchValues,
        allowNestedConditional,
      );

      const patch = corrFieldModel.categoryFormFields.length > 0
        ? buildCorrectionCustomFieldPatch(corrFieldModel, visibleBranchIds)
        : [];

      await ExpenseService.applySingularExpenseCorrection(
        selectedExpense.id,
        user.id,
        {
          title: corrTitle.trim(),
          destination: corrDestination.trim(),
          trip_start: corrExpenseDate,
          trip_end: corrExpenseDate,
          purpose: corrPurpose.trim() || null,
          category: corrCategory.trim() || null,
          total_amount: amt,
          admin_comment: corrAdminComment.trim() || null,
        },
        correctionReason.trim() || null,
        patch,
      );
      toast({ title: t("admin:panel.toast.expenseCorrected"), description: t("admin:panel.toast.expenseCorrectedHint") });
      setCorrectionDialogOpen(false);
      await fetchExpenses();
      setSelectedExpense({
        ...selectedExpense,
        status: "edited",
        title: corrTitle.trim(),
        destination: corrDestination.trim(),
        trip_start: corrExpenseDate,
        trip_end: corrExpenseDate,
        purpose: corrPurpose.trim() || undefined,
        category: corrCategory.trim() || undefined,
        total_amount: amt,
        admin_comment: corrAdminComment.trim() || undefined,
      });
      await fetchCorrectionLogs(selectedExpense.id);
      await fetchAuditLogs(selectedExpense.id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save correction";
      toast({ variant: "destructive", title: t("admin:panel.toast.correctionFailed"), description: msg });
    } finally {
      setCorrectionLoading(false);
    }
  };

  useEffect(() => {
    if (selectedExpense) {
      fetchAttachments(selectedExpense.id);
      fetchAuditLogs(selectedExpense.id);
      if (user?.id) void fetchCorrectionLogs(selectedExpense.id);
    } else {
      setAttachments([]);
      setAuditLogs([]);
      setCorrectionLogs([]);
      setTimelineAssignees({});
    }
  }, [selectedExpense]);

  const fetchUsers = async () => {
    if (!organizationId) return;

    // First get profiles (filtered by organization_id)
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, user_id, name, email, created_at, is_active, balance, reporting_engineer_id")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (profilesError) throw profilesError;

    // Org-scoped roles — one short query instead of user_roles with 200+ IDs in the URL
    const { data: memberships, error: membershipsError } = await supabase
      .from("organization_memberships")
      .select("user_id, role")
      .eq("organization_id", organizationId)
      .eq("is_active", true);

    if (membershipsError) throw membershipsError;

    const roleByUserId = new Map(
      (memberships || []).map((m) => [m.user_id, m.role] as const),
    );

    // Combine the data
    const usersWithRoles = profiles.map(profile => {
      const userRole = roleByUserId.get(profile.user_id);
      return {
        id: profile.user_id,
        email: profile.email,
        name: profile.name,
        role: userRole || "employee",
        created_at: profile.created_at,
        is_active: profile.is_active,
        balance: profile.balance ?? 0,
        reporting_engineer_id: profile.reporting_engineer_id ?? null
      };
    });

    setUsers(usersWithRoles);
  };

  const fetchExpenses = async (options?: { loadAll?: boolean }) => {
    if (!organizationId) {
      return;
    }

    const fetchSeq = ++expensesFetchSeqRef.current;
    const isStale = () => fetchSeq !== expensesFetchSeqRef.current;

    const shouldLoadAll = options?.loadAll ?? allExpensesLoaded;
    const initialFetchLimit = shouldLoadAll ? EXPENSE_FETCH_PAGE_SIZE : EXPENSE_INITIAL_FETCH_LIMIT;

    // Show appropriate fetch progress title based on whether rows already exist
    const hasRows = expensesFetchSeqRef.current <= 1 || expenses.length === 0;
    const isInitial = !hasCompletedExpenseFetch;
    if (!shouldLoadAll) {
      setExpenseFetchError(null);
      startExpenseFetch(
        isInitial
          ? t("admin:review.progress.loadingExpenses")
          : t("admin:review.progress.refreshing"),
        {
          description: isInitial
            ? t("admin:review.progress.loadingExpensesHint")
            : t("admin:review.progress.refreshingHint"),
        },
      );
    }

    setExpensesLoading(true);

    // Fail-open visibility: show every org expense except not-yet-submitted drafts.
    // A status whitelist previously hid legitimate expenses (e.g. `paid`) and could
    // return an empty list when the DB enum lacked a referenced value. Excluding only
    // `draft` references no optional enum value, so it is deterministic and safe.
    const runOrgExpenseQuery = async () => {
      const queryBase = supabase
        .from("expenses")
        .select("*", { count: "exact" })
        .eq("organization_id", organizationId)
        .neq("status", "draft")
        .order("updated_at", { ascending: false });

      let rows: Record<string, unknown>[] = [];
      let error: { message?: string; code?: string } | null = null;
      let count = 0;

      if (shouldLoadAll) {
        let offset = 0;
        while (true) {
          const { data, error: pageError, count: pageCount } = await queryBase.range(
            offset,
            offset + EXPENSE_FETCH_PAGE_SIZE - 1,
          );
          if (pageError) {
            error = pageError;
            break;
          }
          if (offset === 0) {
            count = pageCount || 0;
            // Initialize determinate Load All progress after first page arrives
            const effectiveTotal = count || EXPENSE_FETCH_PAGE_SIZE;
            startLoadAll(t("admin:review.progress.loadAll"), {
              description: t("admin:review.progress.loadAllHint"),
              completed: (data || []).length,
              total: effectiveTotal,
            });
          }
          const chunk = data || [];
          rows.push(...chunk);
          if (rows.length > 0 && (count || 0) > 0) {
            updateLoadAll(t("admin:review.progress.loadAll"), {
              description: t("admin:review.progress.loadedCount", {
                loaded: rows.length,
                total: count,
              }),
              completed: rows.length,
              total: count,
            });
          }
          if (chunk.length < EXPENSE_FETCH_PAGE_SIZE) break;
          offset += EXPENSE_FETCH_PAGE_SIZE;
        }
      } else {
        const { data, error: pageError, count: pageCount } = await queryBase.range(
          0,
          initialFetchLimit - 1,
        );
        rows = data || [];
        error = pageError;
        count = pageCount || 0;
      }

      return { rows, error, count };
    };

    let allExpenses: Record<string, unknown>[];
    let totalCount: number;
    try {
      const result = await runOrgExpenseQuery();
      if (result.error) {
        console.error("[AdminPanel] Error fetching expenses:", result.error);
        setExpensesLoading(false);
        const errMsg = result.error.message || t("admin:panel.toast.loadExpensesFailedHint");
        setExpenseFetchError(errMsg);
        if (shouldLoadAll) {
          failLoadAll(t("admin:review.progress.loadFailed"), errMsg);
        } else {
          failExpenseFetch(t("admin:review.progress.loadFailed"), t("admin:review.progress.loadFailedHint"));
        }
        toast({
          variant: "destructive",
          title: t("admin:panel.toast.loadExpensesFailed"),
          description: errMsg,
        });
        // Do NOT clear expenses — preserve what was previously loaded
        throw result.error;
      }
      allExpenses = result.rows || [];
      totalCount = result.count;
    } catch (e) {
      setExpensesLoading(false);
      throw e;
    }

    if (isStale()) return;

    setTotalExpenseCount(totalCount || allExpenses.length);
    setAllExpensesLoaded(shouldLoadAll && (totalCount === 0 || allExpenses.length >= totalCount));

    if (!allExpenses || allExpenses.length === 0) {
      const { count: allInOrgCount } = await supabase
        .from("expenses")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId);
      if ((allInOrgCount ?? 0) > 0) {
        toast({
          title: t("admin:panel.toast.noExpensesInReview"),
          description: t("admin:panel.toast.noExpensesInReviewHint"),
        });
      }
      if (!isStale()) {
        setExpenses([]);
        setExpensesLoading(false);
        setHasCompletedExpenseFetch(true);
        setExpenseFetchError(null);
        if (!shouldLoadAll) completeExpenseFetch(t("admin:review.progress.updated"));
      }
      return;
    }

    const userIds = [...new Set(allExpenses.map(e => e.user_id))];

    let profiles: {
      user_id: string;
      name: string;
      email: string;
      employee_id: string;
      balance: number | null;
    }[] = [];
    try {
      profiles = await fetchExpenseSubmitterProfiles(supabase, organizationId, userIds);
    } catch (profilesError) {
      console.error("❌ [AdminPanel] Error fetching profiles:", profilesError);
    }

    const profileMap = new Map((profiles ?? []).map((p) => [p.user_id, p]));

    const mapExpensesWithProfiles = (
      resubmittedIds: Set<string>,
      reviewerCorrectedIds: Set<string>,
      customByExpense: Record<string, Record<string, string>>,
    ) =>
      allExpenses.map((expense) => {
        const profile = profileMap.get(expense.user_id as string);
        const expenseId = String(expense.id ?? "");
        return {
          ...expense,
          user_name: profile?.name || "Unknown User",
          user_email: profile?.email || "unknown@example.com",
          user_employee_id: profile?.employee_id || "",
          user_balance: profile?.balance ?? 0,
          total_amount: Number(expense.total_amount ?? 0),
          isResubmitted: resubmittedIds.has(expenseId),
          wasReviewerCorrected: reviewerCorrectedIds.has(expenseId),
          custom_fields: customByExpense[expenseId] ?? {},
        };
      });

    if (isStale()) return;
    // Publish base rows — expense list is now visible, no longer an initial blank page
    setExpenses(mapExpensesWithProfiles(new Set(), new Set(), {}));
    setExpensesLoading(false);
    setHasCompletedExpenseFetch(true);
    setExpenseFetchError(null);

    // Resolve fetch-level progress now — rows are in the table, user perceives load as done
    if (!shouldLoadAll) {
      completeExpenseFetch(t("admin:review.progress.updated"));
    } else {
      completeLoadAll(
        t("admin:review.progress.loadedCount", {
          loaded: allExpenses.length,
          total: Math.max(totalCount, allExpenses.length),
        }),
      );
    }

    const expenseIds = allExpenses
      .map((e) => e.id as string | undefined)
      .filter((id): id is string => Boolean(id));

    if (expenseIds.length === 0) {
      return;
    }

    setExpensesEnriching(true);
    void (async () => {
      let resubmittedIds = new Set<string>();
      let reviewerCorrectedIds = new Set<string>();
      let customByExpense: Record<string, Record<string, string>> = {};

      try {
        // All three enrichment queries are independent — run in parallel.
        const [fetchedResubmitted, fetchedCorrected, fetchedCustom] = await Promise.all([
          fetchResubmittedExpenseIds(supabase, expenseIds, organizationId),
          ExpenseService.getExpenseIdsWithReviewerCorrections(expenseIds, organizationId),
          fetchExpenseCustomFieldsMap(organizationId, expenseIds),
        ]);
        resubmittedIds = fetchedResubmitted;
        reviewerCorrectedIds = fetchedCorrected;
        customByExpense = fetchedCustom;
      } catch (enrichError) {
        console.warn("[AdminPanel] Expense enrichment failed (showing basic rows):", enrichError);
      } finally {
        setExpensesEnriching(false);
      }

      if (isStale()) return;
      setExpenses(mapExpensesWithProfiles(resubmittedIds, reviewerCorrectedIds, customByExpense));
    })();
  };

  const fetchEngineers = async () => {
    if (!organizationId) return;

    // Get engineers from organization_memberships (filtered by organization_id)
    const { data: engineerMemberships, error: membershipsError } = await supabase
      .from("organization_memberships")
      .select("user_id")
      .eq("organization_id", organizationId)
      .eq("role", "engineer")
      .eq("is_active", true);

    if (membershipsError) throw membershipsError;

    if (!engineerMemberships || engineerMemberships.length === 0) {
      setEngineers([]);
      return;
    }

    // Get profiles for engineers (filtered by organization_id)
    const engineerIds = engineerMemberships.map(m => m.user_id);
    const profiles = (await fetchProfilesByUserIds(
      supabase,
      organizationId,
      engineerIds,
      "user_id, name, email",
    )) as { user_id: string; name: string; email: string }[];

    setEngineers(profiles.map(profile => ({
      id: profile.user_id,
      name: profile.name,
      email: profile.email
    })));
  };

  const handleLoadAllExpenses = async (options?: { silent?: boolean }) => {
    try {
      setLoadingAllExpenses(true);
      await fetchExpenses({ loadAll: true });
      sessionStorage.setItem("pesowise:load-all:admin", "true");
      setCurrentPage(1);
      if (!options?.silent) {
        toast({
          title: "All expenses loaded",
          description: "Full expense history is now available in this view.",
        });
      }
    } catch (error) {
      console.error("❌ [AdminPanel] Failed to load all expenses:", error);
      if (!options?.silent) {
        toast({
          title: "Failed to load all expenses",
          description: "Please try again.",
          variant: "destructive",
        });
      }
      throw error;
    } finally {
      setLoadingAllExpenses(false);
    }
  };


  const handleSortByChange = async (value: "created_at" | "trip_start" | "user_name") => {
    setExpenseSortBy(value);
    if (value === "user_name" && !allExpensesLoaded) {
      try {
        await handleLoadAllExpenses({ silent: true });
      } catch (error) {
        console.error("❌ [AdminPanel] Failed auto-load before sorting by name:", error);
        toast({
          title: "Could not load full history",
          description: "Sorting by employee name needs full data. Please try again.",
          variant: "destructive",
        });
      }
    }
  };

  const approveExpense = async () => {
    if (!selectedExpense || !user) return;

    try {
      await ExpenseService.approveExpense(selectedExpense.id, user.id, adminComment);

      toast({
        title: "Expense Approved",
        description: "The expense has been approved successfully",
      });

      setSelectedExpense(null);
      setAdminComment("");
      fetchExpenses();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve expense",
      });
    }
  };


  const assignToEngineer = async () => {
    if (!selectedExpense || !selectedEngineer || !user) return;

    try {
      await ExpenseService.assignToEngineer(selectedExpense.id, selectedEngineer, user.id);

      toast({
        title: "Expense Assigned",
        description: "The expense has been assigned to a manager for review",
      });

      setSelectedExpense(null);
      setSelectedEngineer("");
      fetchExpenses();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to assign expense",
      });
    }
  };

  const verifyExpense = async () => {
    if (!selectedExpense || !user) return;

    if (!["submitted", "edited"].includes(selectedExpense.status)) {
      toast({
        variant: "destructive",
        title: "Cannot verify",
        description: "Only submitted or adjusted expenses can be verified from here.",
      });
      return;
    }

    try {
      // Automatically update status to "verified"
      const updateData: any = {
        status: "verified",
        updated_at: new Date().toISOString()
      };

      if (adminComment) {
        updateData.admin_comment = adminComment;
      }

      const { error } = await supabase
        .from("expenses")
        .update(updateData)
        .eq("id", selectedExpense.id);

      if (error) throw error;

      // Log the action
      await supabase
        .from("audit_logs")
        .insert({
          expense_id: selectedExpense.id,
          user_id: user.id,
          action: "Status changed to verified",
          comment: adminComment || null
        });

      toast({
        title: "Expense Verified",
        description: "Expense has been verified successfully",
      });

      // Close dialog and reset
      setDialogOpen(false);
      setSelectedExpense(null);
      setAdminComment("");
      fetchExpenses();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to verify expense",
      });
    }
  };

  const rejectExpense = async () => {
    if (!selectedExpense || !user) return;

    try {
      setReviewLoading(true);

      await ExpenseService.rejectExpense(selectedExpense.id, user.id, adminComment);

      toast({
        title: "Expense Rejected",
        description: "Expense has been rejected successfully",
      });

      setSelectedExpense(null);
      setAdminComment("");
      setAttachments([]);
      setDialogOpen(false);
      fetchExpenses();
    } catch (error: any) {
      console.error("Error rejecting expense:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to reject expense",
      });
    } finally {
      setReviewLoading(false);
    }
  };

  // Get expenses that can be bulk processed (submitted or verified status)
  const getSelectableExpenses = () => {
    return paginatedExpenses.filter(
      (e) => e.status === "submitted" || e.status === "verified"
    );
  };

  const handleSelectExpense = (expenseId: string, checked: boolean) => {
    const newSelected = new Set(selectedExpenseIds);
    if (checked) {
      newSelected.add(expenseId);
    } else {
      newSelected.delete(expenseId);
    }
    setSelectedExpenseIds(newSelected);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const selectableIds = new Set(getSelectableExpenses().map((e) => e.id));
      setSelectedExpenseIds(selectableIds);
    } else {
      setSelectedExpenseIds(new Set());
    }
  };

  const handleBulkApprove = async () => {
    if (!user || selectedExpenseIds.size === 0) return;

    const expenseIds = Array.from(selectedExpenseIds);
    const expensesToApprove = filteredExpenses.filter(
      (e) =>
        expenseIds.includes(e.id) &&
        (ADMIN_APPROVABLE_STATUSES as readonly string[]).includes(e.status),
    );

    if (expensesToApprove.length === 0) {
      toast({
        variant: "destructive",
        title: "No Valid Expenses",
        description:
          "Selected expenses cannot be approved. Only submitted, verified, adjusted, or hierarchy-verified expenses can be approved.",
      });
      return;
    }

    try {
      setBulkActionLoading(true);
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      startBulkOp(
        t("admin:review.progress.bulkApproving", { current: 0, total: expensesToApprove.length }),
      );

      for (const [idx, expense] of expensesToApprove.entries()) {
        updateBulkOp(
          t("admin:review.progress.bulkApproving", { current: idx + 1, total: expensesToApprove.length }),
        );
        try {
          await ExpenseService.approveExpense(expense.id, user.id, "Bulk approved");
          successCount++;
        } catch (error: any) {
          errorCount++;
          errors.push(
            `${expense.title || expense.id}: ${error.message || "Failed to approve"}`
          );
        }
      }

      if (errorCount > 0) {
        failBulkOp(
          t("admin:review.progress.bulkComplete"),
          t("admin:review.progress.bulkSummary", { succeeded: successCount, failed: errorCount }),
        );
      } else {
        completeBulkOp(t("admin:review.progress.bulkComplete"));
      }

      if (successCount > 0) {
        toast({
          title: "Bulk Approval Complete",
          description: `Successfully approved ${successCount} expense(s).${errorCount > 0 ? ` ${errorCount} failed.` : ""}`,
        });
      }

      if (errorCount > 0 && errors.length > 0) {
        console.error("Bulk approval errors:", errors);
        toast({
          variant: "destructive",
          title: "Some Approvals Failed",
          description: `${errorCount} expense(s) could not be approved. Check console for details.`,
        });
      }

      setSelectedExpenseIds(new Set());
      fetchExpenses();
    } catch (error: any) {
      console.error("Error in bulk approve:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve expenses",
      });
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkReject = async () => {
    if (!user || selectedExpenseIds.size === 0) return;

    const expenseIds = Array.from(selectedExpenseIds);
    const expensesToReject = filteredExpenses.filter(
      (e) =>
        expenseIds.includes(e.id) &&
        (e.status === "submitted" || e.status === "verified")
    );

    if (expensesToReject.length === 0) {
      toast({
        variant: "destructive",
        title: "No Valid Expenses",
        description:
          "Selected expenses cannot be rejected. Only submitted or verified expenses can be rejected.",
      });
      return;
    }

    try {
      setBulkActionLoading(true);
      let successCount = 0;
      let errorCount = 0;
      const errors: string[] = [];

      startBulkOp(
        t("admin:review.progress.bulkRejecting", { current: 0, total: expensesToReject.length }),
      );

      for (const [idx, expense] of expensesToReject.entries()) {
        updateBulkOp(
          t("admin:review.progress.bulkRejecting", { current: idx + 1, total: expensesToReject.length }),
        );
        try {
          await ExpenseService.rejectExpense(expense.id, user.id, "Bulk rejected");
          successCount++;
        } catch (error: any) {
          errorCount++;
          errors.push(
            `${expense.title || expense.id}: ${error.message || "Failed to reject"}`
          );
        }
      }

      if (errorCount > 0) {
        failBulkOp(
          t("admin:review.progress.bulkComplete"),
          t("admin:review.progress.bulkSummary", { succeeded: successCount, failed: errorCount }),
        );
      } else {
        completeBulkOp(t("admin:review.progress.bulkComplete"));
      }

      if (successCount > 0) {
        toast({
          title: "Bulk Rejection Complete",
          description: `Successfully rejected ${successCount} expense(s).${errorCount > 0 ? ` ${errorCount} failed.` : ""}`,
        });
      }

      if (errorCount > 0 && errors.length > 0) {
        console.error("Bulk rejection errors:", errors);
        toast({
          variant: "destructive",
          title: "Some Rejections Failed",
          description: `${errorCount} expense(s) could not be rejected. Check console for details.`,
        });
      }

      setSelectedExpenseIds(new Set());
      fetchExpenses();
    } catch (error: any) {
      console.error("Error in bulk reject:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to reject expenses",
      });
    } finally {
      setBulkActionLoading(false);
    }
  };

  const approveExpenseDirect = async () => {
    if (!selectedExpense || !user) return;

    try {
      // Use ExpenseService to approve (this handles balance deduction)
      await ExpenseService.approveExpense(selectedExpense.id, user.id, adminComment);

      toast({
        title: "Expense Approved",
        description: `Expense approved and ${formatINR(selectedExpense.total_amount)} deducted from employee balance.`,
      });

      // Close dialog and reset
      setDialogOpen(false);
      setSelectedExpense(null);
      setAdminComment("");
      fetchExpenses();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve expense",
      });
    }
  };

  const updateExpenseStatus = async () => {
    if (!selectedExpense || !selectedStatus || !user) return;

    try {
      // Use proper service methods for approve/reject
      if (selectedStatus === "approved") {
        await ExpenseService.approveExpense(selectedExpense.id, user.id, adminComment);
        toast({
          title: "Expense Approved",
          description: `Expense approved and ₹${selectedExpense.total_amount} deducted from employee balance.`,
        });
      } else if (selectedStatus === "submitted" || selectedStatus === "verified") {
        // Only assign to engineer if one is selected
        if (selectedEngineer && selectedEngineer !== "none") {
          await ExpenseService.assignToEngineer(selectedExpense.id, selectedEngineer, user.id);
          toast({
            title: "Expense Assigned",
            description: "The expense has been assigned to a manager for review",
          });
        } else {
          // Just update the status without assigning to engineer
          const updateData: any = {
            status: selectedStatus,
            updated_at: new Date().toISOString()
          };

          if (adminComment) {
            updateData.admin_comment = adminComment;
          }

          const { error } = await supabase
            .from("expenses")
            .update(updateData)
            .eq("id", selectedExpense.id);

          if (error) throw error;

          // Log the action
          await supabase
            .from("audit_logs")
            .insert({
              expense_id: selectedExpense.id,
              user_id: user.id,
              action: `Status changed to ${selectedStatus}`,
              comment: adminComment || null
            });

          toast({
            title: "Success",
            description: "Expense status updated successfully",
          });
        }
      } else {
        // For other status changes, use direct update
        const updateData: any = {
          status: selectedStatus,
          updated_at: new Date().toISOString()
        };

        if (selectedEngineer && selectedEngineer !== "none") {
          updateData.assigned_engineer_id = selectedEngineer;
        } else if (selectedEngineer === "none") {
          updateData.assigned_engineer_id = null;
        }

        if (adminComment) {
          updateData.admin_comment = adminComment;
        }

        const { error } = await supabase
          .from("expenses")
          .update(updateData)
          .eq("id", selectedExpense.id);

        if (error) throw error;

        // Log the action
        await supabase
          .from("audit_logs")
          .insert({
            expense_id: selectedExpense.id,
            user_id: user.id,
            action: `Status changed to ${selectedStatus}`,
            comment: adminComment || null
          });

        toast({
          title: "Success",
          description: "Expense status updated successfully",
        });
      }

      setDialogOpen(false);
      setSelectedExpense(null);
      setAdminComment("");
      setSelectedStatus("");
      setSelectedEngineer("");
      fetchExpenses();
    } catch (error: any) {
      console.error("Error updating expense:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update expense",
      });
    }
  };

  const updateUserRole = async (userId: string, newRole: string) => {
    try {
      const { error } = await supabase
        .from("user_roles")
        .upsert({
          user_id: userId,
          role: newRole
        });

      if (error) throw error;

      toast({
        title: "Success",
        description: "User role updated successfully",
      });

      fetchUsers();
    } catch (error: any) {
      console.error("Error updating user role:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to update user role",
      });
    }
  };

  // Filter and search functions
  const filteredExpenses = expenses.filter(expense => {
    const matchesSearch = expenseRowMatchesSearch(
      {
        ...expense,
        transaction_number: (expense as any).transaction_number,
      },
      searchTerm,
      expenseSearchIdentityOptions,
    );

    const matchesStatus = statusFilter === "all" || expense.status === statusFilter;
    const matchesCustomFields = matchesCustomFieldFilters(
      expense.custom_fields,
      customFieldFilters,
    );

    return matchesSearch && matchesStatus && matchesCustomFields;
  });

  const sortedExpenses = [...filteredExpenses].sort((a, b) => {
    let aValue: number | string;
    let bValue: number | string;

    switch (expenseSortBy) {
      case "user_name":
        aValue = a.user_name.toLowerCase();
        bValue = b.user_name.toLowerCase();
        break;
      case "trip_start":
        aValue = parseLocalDate(a.trip_start)?.getTime() ?? new Date(a.trip_start).getTime();
        bValue = parseLocalDate(b.trip_start)?.getTime() ?? new Date(b.trip_start).getTime();
        break;
      case "created_at":
      default:
        aValue = new Date(a.created_at).getTime();
        bValue = new Date(b.created_at).getTime();
        break;
    }

    if (typeof aValue === "string") {
      const cmp = aValue.localeCompare(bValue as string, undefined, { sensitivity: "base" });
      return expenseSortOrder === "asc" ? cmp : -cmp;
    }

    if (expenseSortOrder === "asc") {
      return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
    }
    return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
  });

  const totalPages = Math.max(1, Math.ceil(sortedExpenses.length / EXPENSES_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safeCurrentPage - 1) * EXPENSES_PER_PAGE;
  const paginatedExpenses = sortedExpenses.slice(
    pageStartIndex,
    pageStartIndex + EXPENSES_PER_PAGE
  );

  useEffect(() => {
    if (!filterMountedRef.current) {
      filterMountedRef.current = true;
      return;
    }
    setCurrentPage(1);
  }, [searchTerm, statusFilter, expenseSortBy, expenseSortOrder, customFieldFilters]);

  useEffect(() => {
    sessionStorage.setItem("pesowise:admin-expenses-page", String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const getVisiblePageNumbers = () => {
    const maxVisible = 7;
    if (totalPages <= maxVisible) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages = new Set<number>();
    pages.add(1);
    pages.add(totalPages);

    const start = Math.max(2, safeCurrentPage - 1);
    const end = Math.min(totalPages - 1, safeCurrentPage + 1);
    for (let i = start; i <= end; i += 1) pages.add(i);

    if (safeCurrentPage <= 3) {
      pages.add(2);
      pages.add(3);
      pages.add(4);
    }
    if (safeCurrentPage >= totalPages - 2) {
      pages.add(totalPages - 1);
      pages.add(totalPages - 2);
      pages.add(totalPages - 3);
    }

    return Array.from(pages)
      .filter((p) => p >= 1 && p <= totalPages)
      .sort((a, b) => a - b);
  };


  const chunkIds = <T,>(arr: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  const exportExpenses = async () => {
    try {
      const expenseIds = filteredExpenses.map((e) => e.id);
      const customByExpense: Record<string, Record<string, string>> = {};

      if (organizationId && expenseIds.length > 0) {
        for (const batch of chunkIds(expenseIds, 100)) {
          const { data, error } = await supabase
            .from("expense_form_field_values")
            .select("expense_id, field_value, expense_form_field_templates(name)")
            .in("expense_id", batch)
            .eq("organization_id", organizationId);

          if (error) {
            console.warn("Failed to fetch custom fields for export", error);
            continue;
          }

          for (const row of data || []) {
            const r = row as {
              expense_id: string;
              field_value: string;
              expense_form_field_templates: { name: string } | null;
            };
            const fieldName = r.expense_form_field_templates?.name ?? "Unknown field";
            if (!customByExpense[r.expense_id]) customByExpense[r.expense_id] = {};
            customByExpense[r.expense_id][fieldName] = String(r.field_value ?? "");
          }
        }
      }

      const customHeaders = Array.from(
        new Set(
          filteredExpenses.flatMap((e) =>
            Object.keys(customByExpense[e.id] || {})
          )
        )
      ).sort((a, b) => a.localeCompare(b));

      // Running balances per employee:
      // approved => deducted from wallet (-amount), other statuses => no wallet deduction.
      // Start from inferred opening so last row closes at current profile balance.
      const balanceByExpenseId = new Map<string, { opening: number; closing: number }>();
      const byUser = new Map<string, Expense[]>();
      filteredExpenses.forEach((e) => {
        if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
        byUser.get(e.user_id)!.push(e);
      });
      for (const [, userExpenses] of byUser) {
        const sorted = [...userExpenses].sort((a, b) => {
          const d = new Date(a.trip_start).getTime() - new Date(b.trip_start).getTime();
          if (d !== 0) return d;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        const currentBalance = Number(sorted[0]?.user_balance ?? 0);
        const totalEffect = sorted.reduce((sum, e) => {
          const amt = Number(e.total_amount || 0);
          return sum + (e.status === "approved" ? -amt : 0);
        }, 0);
        let running = currentBalance - totalEffect;
        for (const e of sorted) {
          const opening = running;
          const amt = Number(e.total_amount || 0);
          const effect = e.status === "approved" ? -amt : 0;
          running += effect;
          balanceByExpenseId.set(e.id, { opening, closing: running });
        }
      }

      const headers = [
        "Employee Name",
        "Employee Email",
        "Transaction Date",
        "Submitted At",
        "Status",
        "Transaction Number",
        "Expense Title",
        "Purpose",
        "Category",
        "Location",
        "Amount (INR)",
        ...customHeaders,
        "Opening Balance (INR)",
        "Closing Balance (INR)",
      ];

      const rows = filteredExpenses.map((expense) => {
        const custom = customByExpense[expense.id] || {};
        const bal = balanceByExpenseId.get(expense.id) ?? { opening: 0, closing: 0 };
        return [
          (expense.user_name || "").trim(),
          (expense.user_email || "").trim(),
          formatCsvDate(expense.trip_start),
          formatCsvTimestamp(expense.created_at),
          (expense.status || "").trim(),
          (expense.transaction_number || "").trim(),
          (expense.title || "").trim(),
          (expense.purpose || "").trim(),
          (expense.category || "N/A").trim(),
          (expense.destination || "Unassigned").trim(),
          Number(expense.total_amount || 0).toFixed(2),
          ...customHeaders.map((h) => (custom[h] ?? "").trim()),
          Number(bal.opening).toFixed(2),
          Number(bal.closing).toFixed(2),
        ];
      });

      // Integrity guard: every data row must have the same cell count as the header.
      const expectedCols = headers.length;
      const mismatch = rows.findIndex((r) => r.length !== expectedCols);
      if (mismatch !== -1) {
        console.error(
          `CSV column mismatch on row ${mismatch}: expected ${expectedCols}, got ${rows[mismatch].length}`,
          rows[mismatch],
        );
        toast({
          variant: "destructive",
          title: "Export failed",
          description: `Row ${mismatch + 1} has ${rows[mismatch].length} columns but header has ${expectedCols}. Please contact support.`,
        });
        return;
      }

      const csvContent = serializeCsv(headers, rows);

      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `expenses-${format(new Date(), "yyyy-MM-dd")}.csv`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error exporting expenses:", error);
      toast({
        variant: "destructive",
        title: t("admin:panel.toast.exportFailed"),
        description: t("admin:panel.toast.exportFailedHint"),
      });
    }
  };

  const handleDownloadBackup = async () => {
    if (!organizationId) return;
    try {
      setBackupLoading(true);
      const payload = await fetchOrgBackup(supabase, organizationId);
      if (includeReceipts && payload.attachments.length > 0) {
        const receiptBlobs = await fetchReceiptBlobs(supabase, payload.attachments);
        await downloadBackupWithReceipts(payload, receiptBlobs);
        toast({ title: t("admin:panel.toast.backupDownloaded"), description: t("admin:panel.toast.backupWithReceipts", { count: receiptBlobs.length }) });
      } else {
        downloadBackup(payload);
        toast({ title: t("admin:panel.toast.backupDownloaded"), description: t("admin:panel.toast.backupSaved") });
      }
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("admin:panel.toast.backupFailed"),
        description: e instanceof Error ? e.message : t("admin:panel.toast.backupFailedHint"),
      });
    } finally {
      setBackupLoading(false);
    }
  };

  const getStats = () => {
    const totalExpenses = expenses.length;
    const pendingExpenses = expenses.filter((e) =>
      ["submitted", "verified", "level_1_verified", "level_2_verified", "edited"].includes(
        e.status,
      ),
    ).length;
    const approvedExpenses = expenses.filter(e => e.status === "approved").length;
    const totalAmount = expenses.reduce((sum, e) => sum + e.total_amount, 0);

    return {
      totalExpenses,
      pendingExpenses,
      approvedExpenses,
      totalAmount,
      totalUsers: users.length
    };
  };

  const stats = getStats();

  if (userRole !== "admin") {
    return (
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">{t("common:accessDenied.title")}</h1>
          <p className="text-muted-foreground">{t("common:accessDenied.defaultDescription")}</p>
        </div>
      </div>
    );
  }

  // ── Mobile branch ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <>
        {selectedExpense ? (
          <MobileAdminExpenseDetailView
            expense={reviewExpense ?? selectedExpense}
            attachments={attachments}
            auditLogs={auditLogs}
            correctionLogs={correctionLogs}
            adminComment={adminComment}
            setAdminComment={setAdminComment}
            selectedStatus={selectedStatus}
            setSelectedStatus={setSelectedStatus}
            selectedEngineer={selectedEngineer}
            setSelectedEngineer={setSelectedEngineer}
            engineers={engineers}
            reviewLoading={reviewLoading}
            hierarchyEnabled={hierarchyEnabled}
            teamLeaderTierEnabled={teamLeaderTierEnabled}
            executiveTierEnabled={executiveTierEnabled}
            canCorrect={canReviewerCorrectExpense(selectedExpense)}
            onApprove={approveExpenseDirect}
            onReject={rejectExpense}
            onVerify={verifyExpense}
            onUpdateStatus={updateExpenseStatus}
            onOpenCorrection={openCorrectionDialog}
            onClose={() => {
              setSelectedExpense(null);
              setAdminComment("");
              setSelectedStatus("");
              setSelectedEngineer("");
            }}
            organizationId={organizationId}
            onImagePreviewOpen={(url, ct, by) => {
              setImagePreviewUrl(url);
              setPreviewContentType(ct);
              setPreviewUploadedBy(by);
              setImagePreviewOpen(true);
            }}
            employeeIdLoginEnabled={employeeIdLoginEnabled}
            timelineAssignees={timelineAssignees}
          />
        ) : (
          <MobileAdminExpensesView
            stats={stats}
            filteredExpenses={sortedExpenses}
            expensesLoading={expensesLoading}
            searchTerm={searchTerm}
            setSearchTerm={setSearchTerm}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            customFieldFilters={customFieldFilters}
            setCustomFieldFilters={setCustomFieldFilters}
            filterableCustomFields={filterableCustomFields}
            totalExpenseCount={totalExpenseCount}
            expenses={expenses}
            allExpensesLoaded={allExpensesLoaded}
            loadingAllExpenses={loadingAllExpenses}
            onLoadAllExpenses={handleLoadAllExpenses}
            loadAllProgressStatus={loadAllProgress.status}
            loadAllProgressTitle={loadAllProgress.phase || undefined}
            loadAllProgressDescription={loadAllProgress.description}
            loadAllProgressCompleted={loadAllProgress.completed}
            loadAllProgressTotal={loadAllProgress.total}
            expenseFetchProgressStatus={expenseFetchProgress.status}
            expenseFetchProgressTitle={expenseFetchProgress.phase || undefined}
            expenseFetchProgressDescription={expenseFetchProgress.description}
            hasCompletedExpenseFetch={hasCompletedExpenseFetch}
            bulkProgressStatus={bulkProgress.status}
            bulkProgressTitle={bulkProgress.phase || undefined}
            bulkProgressDescription={bulkProgress.description}
            onSelectExpense={(expense) => {
              if (expense.batch_id) {
                navigate(
                  `/expenses/batch/${expense.batch_id}/review?from=admin&expense=${expense.id}`,
                );
                return;
              }
              setSelectedExpense(expense);
            }}
            employeeIdLoginEnabled={employeeIdLoginEnabled}
          />
        )}

        {/* Correction dialog — overlay, shared with mobile detail view */}
        <Dialog open={correctionDialogOpen} onOpenChange={setCorrectionDialogOpen}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Correct expense (on behalf of employee)</DialogTitle>
              <DialogDescription>
                Saves a before/after audit record and sets status to Adjusted. The employee
                continues to see this as submitted while in review.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <Label htmlFor="m-corr-title">Title</Label>
                <Input
                  id="m-corr-title"
                  value={corrTitle}
                  onChange={(e) => setCorrTitle(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="m-corr-dest">Destination</Label>
                <Input
                  id="m-corr-dest"
                  value={corrDestination}
                  onChange={(e) => setCorrDestination(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="m-corr-date">Date of expense</Label>
                <Input
                  id="m-corr-date"
                  type="date"
                  value={corrExpenseDate}
                  onChange={(e) => setCorrExpenseDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Same as the employee expense form — one date is stored for this expense.
                </p>
              </div>
              <div>
                <Label htmlFor="m-corr-pur">Purpose</Label>
                <Textarea
                  id="m-corr-pur"
                  value={corrPurpose}
                  onChange={(e) => setCorrPurpose(e.target.value)}
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor="m-corr-cat">Category</Label>
                <ExpenseCategorySelect
                  id="m-corr-cat"
                  organizationId={organizationId}
                  value={corrCategory}
                  onChange={setCorrCategory}
                />
              </div>
              <div>
                <Label htmlFor="m-corr-amt">Total amount</Label>
                <Input
                  id="m-corr-amt"
                  type="number"
                  min={0}
                  step="0.01"
                  value={corrAmount}
                  onChange={(e) => setCorrAmount(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="m-corr-ac">Admin comment (stored on expense)</Label>
                <Textarea
                  id="m-corr-ac"
                  value={corrAdminComment}
                  onChange={(e) => setCorrAdminComment(e.target.value)}
                  rows={2}
                />
              </div>
              {corrFieldModel.loadError && (
                <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  {corrFieldModel.loadError}
                </p>
              )}
              <CorrectionCustomFieldsSection
                categoryFormFields={corrFieldModel.categoryFormFields}
                formFieldValues={corrFieldModel.formFieldValues}
                onFormFieldValuesChange={(vals) =>
                  setCorrFieldModel((prev) => ({ ...prev, formFieldValues: vals }))
                }
                optionBranches={corrFieldModel.optionBranches}
                branchValues={corrFieldModel.branchValues}
                onBranchValuesChange={(vals) =>
                  setCorrFieldModel((prev) => ({ ...prev, branchValues: vals }))
                }
                allowNested={allowNestedConditional}
                organizationId={organizationId}
                onSelectOptionValue={handleCorrectionSelectOptionValue}
              />
              <div>
                <Label htmlFor="m-corr-reason">Reason for correction (audit)</Label>
                <Textarea
                  id="m-corr-reason"
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  rows={2}
                  placeholder="Optional note explaining the change"
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCorrectionDialogOpen(false)}
                disabled={correctionLoading}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void submitExpenseCorrection()}
                disabled={correctionLoading}
              >
                {correctionLoading ? "Saving…" : "Save correction"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AttachmentPreviewDialog
          open={imagePreviewOpen}
          onOpenChange={setImagePreviewOpen}
          url={imagePreviewUrl}
          contentType={previewContentType}
          uploadedBy={previewUploadedBy}
          expenseId={selectedExpense?.id ?? null}
        />
      </>
    );
  }
  // ── End mobile branch ──────────────────────────────────────────────────────

  return (
    <div className="space-y-8">
      {/* Mobile-optimized Header Section */}
      <div className="text-center space-y-3 sm:space-y-4">
        <div className="inline-flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-r from-purple-600 to-pink-600 rounded-xl sm:rounded-2xl shadow-lg">
          <Settings className="h-6 w-6 sm:h-8 sm:w-8 text-white" />
        </div>
        <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
          {t("admin:panel.title")}
        </h1>
        <p className="text-sm sm:text-base lg:text-lg text-gray-600 max-w-2xl mx-auto px-4">
          {t("admin:panel.description")}
        </p>
        <SubmitExpenseActions className="justify-center" addExpenseVariant="outline" />
      </div>

      {/* Mobile-optimized Stats Cards */}
      <div className="grid gap-3 sm:gap-4 md:gap-6 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm hover:shadow-2xl transition-all duration-300">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 sm:space-y-2 min-w-0 flex-1 overflow-hidden">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{t("admin:panel.stats.totalUsers")}</p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 whitespace-nowrap">{stats.totalUsers}</p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg sm:rounded-xl flex items-center justify-center shadow-lg flex-shrink-0 ml-2">
                <Users className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm hover:shadow-2xl transition-all duration-300">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 sm:space-y-2 min-w-0 flex-1 overflow-hidden">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{t("admin:panel.stats.totalExpenses")}</p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 whitespace-nowrap">{stats.totalExpenses}</p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-lg sm:rounded-xl flex items-center justify-center shadow-lg flex-shrink-0 ml-2">
                <Receipt className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm hover:shadow-2xl transition-all duration-300">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 sm:space-y-2 min-w-0 flex-1 overflow-hidden">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{t("admin:panel.stats.pending")}</p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 whitespace-nowrap">{stats.pendingExpenses}</p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-yellow-500 to-orange-500 rounded-lg sm:rounded-xl flex items-center justify-center shadow-lg flex-shrink-0 ml-2">
                <Clock className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm hover:shadow-2xl transition-all duration-300">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 sm:space-y-2 min-w-0 flex-1 overflow-hidden">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{t("admin:panel.stats.approved")}</p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 whitespace-nowrap">{stats.approvedExpenses}</p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg sm:rounded-xl flex items-center justify-center shadow-lg flex-shrink-0 ml-2">
                <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm hover:shadow-2xl transition-all duration-300">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1 sm:space-y-2 min-w-0 flex-1 overflow-hidden">
                <p className="text-xs sm:text-sm font-medium text-gray-600 truncate">{t("admin:panel.stats.totalAmount")}</p>
                <p className="text-xl sm:text-2xl font-bold text-gray-900 whitespace-nowrap overflow-hidden text-ellipsis">{formatINR(stats.totalAmount, moneyLocale)}</p>
              </div>
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-r from-purple-500 to-purple-600 rounded-lg sm:rounded-xl flex items-center justify-center shadow-lg flex-shrink-0 ml-2">
                <Coins className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <div className="space-y-4">
        {/* Search and Filter Controls */}
        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardHeader className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                <Filter className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-xl font-bold">{t("admin:panel.searchFilter.title")}</CardTitle>
                <CardDescription className="text-blue-100">{t("admin:panel.searchFilter.description")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-2 sm:col-span-2 lg:col-span-1">
                <label className="text-xs sm:text-sm font-medium text-gray-700">{t("admin:panel.searchFilter.search")}</label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder={t("admin:panel.searchFilter.searchPlaceholder")}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10 h-10 sm:h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 text-sm"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs sm:text-sm font-medium text-gray-700">{t("admin:panel.searchFilter.statusFilter")}</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-10 sm:h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 text-sm">
                    <SelectValue placeholder={t("admin:panel.searchFilter.allStatuses")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("admin:panel.searchFilter.allStatuses")}</SelectItem>
                    <SelectItem value="submitted">{t("expenses:status.submitted")}</SelectItem>
                    <SelectItem value="edited">{t("expenses:status.edited")}</SelectItem>
                    <SelectItem value="level_1_verified">{t("expenses:status.level1Verified")}</SelectItem>
                    <SelectItem value="level_2_verified">{t("expenses:status.level2Verified")}</SelectItem>
                    <SelectItem value="verified">{t("expenses:status.verified")}</SelectItem>
                    <SelectItem value="approved">{t("expenses:status.approved")}</SelectItem>
                    <SelectItem value="rejected">{t("expenses:status.rejected")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs sm:text-sm font-medium text-gray-700">{t("admin:panel.searchFilter.sortBy")}</label>
                <div className="flex items-center gap-2">
                  <Select
                    value={expenseSortBy}
                    onValueChange={(v) =>
                      void handleSortByChange(v as "created_at" | "trip_start" | "user_name")
                    }
                  >
                    <SelectTrigger className="h-10 sm:h-12 border-gray-200 focus:border-blue-500 focus:ring-blue-500/20 text-sm">
                      <SelectValue placeholder={t("admin:panel.searchFilter.sortPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="created_at">{t("admin:panel.searchFilter.dateCreated")}</SelectItem>
                      <SelectItem value="trip_start">{t("admin:panel.searchFilter.expenseDate")}</SelectItem>
                      <SelectItem value="user_name">{t("admin:panel.searchFilter.employeeName")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-10 sm:h-12 shrink-0 px-3"
                    onClick={() => setExpenseSortOrder(expenseSortOrder === "asc" ? "desc" : "asc")}
                    aria-label={expenseSortOrder === "asc" ? "Sort ascending" : "Sort descending"}
                  >
                    {expenseSortOrder === "asc" ? "↑" : "↓"}
                  </Button>
                </div>
              </div>

              <ExpenseCustomFieldFilters
                fields={filterableCustomFields}
                values={customFieldFilters}
                onChange={setCustomFieldFilters}
                className="sm:col-span-2 lg:col-span-3"
              />

              <div className="space-y-2">
                <label className="text-xs sm:text-sm font-medium text-gray-700">{t("admin:panel.searchFilter.actions")}</label>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="admin-include-receipts"
                    checked={includeReceipts}
                    onCheckedChange={(v) => setIncludeReceipts(v === true)}
                  />
                  <Label htmlFor="admin-include-receipts" className="text-xs font-normal cursor-pointer">{t("admin:panel.searchFilter.includeReceipts")}</Label>
                </div>
                <div className="flex flex-col gap-2">
                  <Button
                    onClick={exportExpenses}
                    className="w-full h-10 sm:h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white text-sm"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    <span className="hidden sm:inline">{t("admin:panel.searchFilter.exportCsv")}</span>
                    <span className="sm:hidden">{t("admin:panel.searchFilter.export")}</span>
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleDownloadBackup}
                    disabled={backupLoading || !organizationId}
                    className="w-full h-10 sm:h-12 text-sm"
                  >
                    <Database className="h-4 w-4 mr-2" />
                    {backupLoading ? t("admin:panel.searchFilter.preparing") : includeReceipts ? t("admin:panel.searchFilter.downloadBackupZip") : t("admin:panel.searchFilter.downloadBackup")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => navigate("/settings")}
                    className="w-full h-10 sm:h-12 text-sm"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Restore from backup
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3 sm:mt-4 text-xs sm:text-sm text-gray-600">
              Showing {sortedExpenses.length === 0 ? 0 : pageStartIndex + 1}-
              {Math.min(pageStartIndex + EXPENSES_PER_PAGE, sortedExpenses.length)} of {sortedExpenses.length} expenses
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-xs sm:text-sm">
              <p className="text-gray-600">
                Loaded {expenses.length.toLocaleString()} of {Math.max(totalExpenseCount, expenses.length).toLocaleString()} total organization expenses
              </p>
              <div className="flex flex-col gap-2">
                {loadAllProgress.status !== "idle" && (
                  <AsyncOperationProgress
                    status={loadAllProgress.status}
                    title={loadAllProgress.phase}
                    description={loadAllProgress.description}
                    showSuccess={loadAllProgress.status === "success"}
                  />
                )}
                {!allExpensesLoaded && expenses.length < Math.max(totalExpenseCount, expenses.length) && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleLoadAllExpenses}
                    disabled={loadingAllExpenses}
                  >
                    {loadingAllExpenses
                      ? t("admin:review.progress.loadingButton", {
                          loaded: expenses.length,
                          total: Math.max(totalExpenseCount, expenses.length),
                        })
                      : t("admin:review.progress.loadAllButton", {
                          total: Math.max(totalExpenseCount, expenses.length),
                        })}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <AdminExpenseImportPanel
          organizationId={organizationId}
          onImported={() => void fetchExpenses()}
        />

        <Card className="shadow-xl border-0 bg-white/80 backdrop-blur-sm">
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="text-lg sm:text-xl font-bold">All Expenses</CardTitle>
            <CardDescription className="text-xs sm:text-sm">Review and manage expense submissions from all users</CardDescription>
          </CardHeader>
          <CardContent className="p-4 sm:p-6">
            {(() => {
              const hasVisibleExpenses = expenses.length > 0;
              const isInitialLoad = expensesLoading && !hasVisibleExpenses && !hasCompletedExpenseFetch;
              if (isInitialLoad) {
                return (
                  <div className="py-8">
                    <AsyncOperationProgress
                      status={expenseFetchProgress.status !== "idle" ? expenseFetchProgress.status : "running"}
                      title={expenseFetchProgress.phase || t("admin:review.progress.loadingExpenses")}
                      description={expenseFetchProgress.description || t("admin:review.progress.loadingExpensesHint")}
                    />
                  </div>
                );
              }
              return (
              <>
                {expensesLoading && expenses.length > 0 && !loadingAllExpenses && expenseFetchProgress.status !== "idle" && (
                  <div className="mb-3">
                    <AsyncOperationProgress
                      status={expenseFetchProgress.status}
                      title={expenseFetchProgress.phase}
                      description={expenseFetchProgress.description}
                      compact
                    />
                  </div>
                )}
                {bulkProgress.status !== "idle" && (
                  <div className="mb-4">
                    <AsyncOperationProgress
                      status={bulkProgress.status}
                      title={bulkProgress.phase}
                      description={bulkProgress.description}
                      showSuccess={bulkProgress.status === "success"}
                    />
                  </div>
                )}
                {selectedExpenseIds.size > 0 && (
                  <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div className="text-sm font-medium text-blue-900">
                      {selectedExpenseIds.size} expense(s) selected
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        onClick={handleBulkApprove}
                        disabled={bulkActionLoading}
                        className="bg-green-600 hover:bg-green-700 text-white"
                        size="sm"
                      >
                        <CheckCircle className="h-4 w-4 mr-2" />
                        Bulk Approve
                      </Button>
                      <Button
                        onClick={handleBulkReject}
                        disabled={bulkActionLoading}
                        variant="destructive"
                        size="sm"
                      >
                        <XCircle className="h-4 w-4 mr-2" />
                        Bulk Reject
                      </Button>
                      <Button
                        onClick={() => setSelectedExpenseIds(new Set())}
                        variant="outline"
                        size="sm"
                        disabled={bulkActionLoading}
                      >
                        Clear Selection
                      </Button>
                    </div>
                  </div>
                )}
                {sortedExpenses.length === 0 ? (
                  <div className="min-h-[240px] flex flex-col items-center justify-center text-center px-4">
                    <Receipt className="h-10 w-10 text-muted-foreground mb-3" />
                    <p className="font-medium text-gray-900">No expenses match your filters</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-md">
                      {expenses.length > 0
                        ? "Try All Statuses and clear custom field filters."
                        : "No reviewable expenses were loaded for this organization."}
                    </p>
                  </div>
                ) : (
                  <div data-testid="admin-expenses-scroll-container" className="relative w-full overflow-x-auto -mx-4 sm:mx-0 expense-table-dense">
                    <Table noScrollWrapper className="w-full">
                      <TableHeader>
                        <TableRow className="border-gray-200">
                          <TableHead className="font-semibold w-10">
                            <Checkbox
                              checked={
                                getSelectableExpenses().length > 0 &&
                                getSelectableExpenses().every((e) => selectedExpenseIds.has(e.id))
                              }
                              onCheckedChange={(v) => handleSelectAll(v === true)}
                              disabled={getSelectableExpenses().length === 0}
                            />
                          </TableHead>
                          <TableHead className="font-semibold w-[64px] min-w-[60px] whitespace-nowrap">Txn #</TableHead>
                          {/* Flexible columns: min-w only, no fixed width -- table-layout:auto
                              hands these any leftover space beyond the fixed columns' total,
                              so wide screens show more Employee/Title/Category/Destination
                              text instead of an empty gap before Actions. */}
                          <TableHead className="font-semibold min-w-[150px]">Employee / Employee ID</TableHead>
                          <TableHead className="font-semibold min-w-[130px]">Title</TableHead>
                          <TableHead className="font-semibold min-w-[90px]">Category</TableHead>
                          <TableHead className="font-semibold min-w-[100px]">Destination</TableHead>
                          <TableHead className="font-semibold w-[85px] min-w-[85px] whitespace-nowrap text-right">Amount</TableHead>
                          <TableHead className="font-semibold w-[95px] min-w-[95px] whitespace-nowrap text-right">Balance</TableHead>
                          <TableHead className="font-semibold w-[90px] min-w-[90px]">Status</TableHead>
                          <TableHead className="font-semibold w-[95px] min-w-[95px] whitespace-nowrap text-right pr-2 sm:pr-4">Expense Date</TableHead>
                          {/* Must fit formatCreatedDateTime's full "Aug 27, 2026 at 12:26 PM". */}
                          <TableHead className="font-semibold w-[165px] min-w-[165px] whitespace-nowrap text-right pr-2 sm:pr-4">{t("admin:panel.searchFilter.dateCreated")}</TableHead>
                          {/* Fixed, compact -- previously only had a minimum, so
                              table-layout:auto handed it 100% of any leftover
                              table width instead of the flexible columns above. */}
                          <TableHead data-testid="admin-expenses-actions-header" className="sticky right-0 z-30 w-[125px] min-w-[110px] max-w-[140px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right font-semibold">Status / Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {paginatedExpenses.map((expense) => {
                          const isSelectable =
                            expense.status === "submitted" || expense.status === "verified";
                          const isSelected = selectedExpenseIds.has(expense.id);
                          return (
                            <TableRow key={expense.id} className="group">
                              <TableCell className="w-10">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={(checked) =>
                                    handleSelectExpense(expense.id, checked as boolean)
                                  }
                                  disabled={!isSelectable || bulkActionLoading}
                                />
                              </TableCell>
                              <TableCell className="font-mono font-semibold text-blue-600 whitespace-nowrap">
                                {(expense as any).transaction_number || '-'}
                              </TableCell>
                              <TableCell className="min-w-0">
                                <div className="min-w-0">
                                  <div className="font-medium truncate">{expense.user_name}</div>
                                  <div className={`etd-secondary truncate ${employeeIdLoginEnabled && expense.user_employee_id ? "font-mono font-medium text-foreground" : "text-muted-foreground"}`}>
                                    {employeeIdLoginEnabled
                                      ? (expense.user_employee_id?.trim() || "—")
                                      : (expense.user_employee_id?.trim() || expense.user_email || "—")}
                                  </div>
                                  {!employeeIdLoginEnabled && (
                                    <div className="etd-secondary text-muted-foreground truncate sm:hidden">{expense.user_email}</div>
                                  )}
                                  {expense.batch_id && (
                                    <Badge variant="outline" className="etd-badge mt-1 bg-violet-50 text-violet-700 border-violet-200">
                                      Batch
                                    </Badge>
                                  )}
                                  <div className="etd-secondary text-muted-foreground sm:hidden mt-1">{expense.destination}</div>
                                  <div className="etd-secondary text-muted-foreground sm:hidden mt-1">
                                    Expense: {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                                  </div>
                                  <div className="etd-secondary text-muted-foreground sm:hidden">
                                    {t("admin:panel.searchFilter.dateCreated")}: {formatCreatedDateTime(expense.created_at)}
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="font-medium min-w-0" title={expense.title}>
                                <div className="truncate">{expense.title}</div>
                              </TableCell>
                              {/* No max-w cap -- Category/Destination are flexible columns
                                  now (see the TableHead widths above); a fixed cap here
                                  would fight the column's own, possibly much larger,
                                  computed width and defeat "show more text on wide screens". */}
                              <TableCell className="capitalize truncate min-w-0" title={expense.category ?? undefined}>{expense.category ?? "-"}</TableCell>
                              <TableCell className="truncate min-w-0" title={expense.destination}>{expense.destination}</TableCell>
                              <TableCell className="etd-numeric whitespace-nowrap font-medium text-right">{formatINR(expense.total_amount)}</TableCell>
                              <TableCell className="text-right">
                                <div className={`etd-numeric font-medium whitespace-nowrap ${expense.user_balance >= expense.total_amount
                                  ? 'text-green-600'
                                  : 'text-red-600'
                                  }`}>
                                  {formatINR(expense.user_balance)}
                                </div>
                                {expense.user_balance < expense.total_amount && (
                                  <div className="etd-secondary text-red-500 whitespace-nowrap">
                                    Insufficient balance
                                  </div>
                                )}
                              </TableCell>
                              <TableCell>
                                {(expense as any).isResubmitted && expense.status === "submitted" ? (
                                  <Badge variant="outline" className="etd-badge bg-blue-50 text-blue-700 border-blue-200">
                                    Resubmitted
                                  </Badge>
                                ) : (
                                  <ExpenseStatusWithCorrectionBadge
                                    status={expense.status}
                                    wasReviewerCorrected={expense.wasReviewerCorrected}
                                    viewerContext="reviewer"
                                  />
                                )}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right pr-2 sm:pr-4">
                                {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right pr-2 sm:pr-4">
                                {formatCreatedDateTime(expense.created_at)}
                              </TableCell>
                              <TableCell data-testid="admin-expenses-actions-cell" className="sticky right-0 z-20 w-[125px] min-w-[110px] max-w-[140px] border-l bg-background group-hover:bg-muted text-right">
                                {/* sm:justify-end fixes the header/button misalignment:
                                    this container previously had no horizontal
                                    justify-content, so its one visible child (the
                                    button) sat at flex-start regardless of the cell's
                                    width -- while the header text was right-aligned. */}
                                <div className="flex flex-col sm:flex-row sm:justify-end items-end gap-2 sm:gap-0">
                                  <div className="sm:hidden mb-2">
                                    {(expense as any).isResubmitted && expense.status === "submitted" ? (
                                      <Badge variant="outline" className="etd-badge bg-blue-50 text-blue-700 border-blue-200">
                                        Resubmitted
                                      </Badge>
                                    ) : (
                                      <ExpenseStatusWithCorrectionBadge
                                        status={expense.status}
                                        wasReviewerCorrected={expense.wasReviewerCorrected}
                                        viewerContext="reviewer"
                                      />
                                    )}
                                  </div>
                                  <div className="flex justify-end shrink-0">
                                    <Button
                                      variant={(expense.status || "").toLowerCase() === "approved" || (expense.status || "").toLowerCase() === "rejected" ? "secondary" : "default"}
                                      size="sm"
                                      className={(expense.status || "").toLowerCase() === "approved" || (expense.status || "").toLowerCase() === "rejected"
                                        ? "etd-control font-normal whitespace-nowrap"
                                        : "etd-control font-medium bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
                                      }
                                      onClick={() => {
                                        if (expense.batch_id) {
                                          navigate(
                                            `/expenses/batch/${expense.batch_id}/review?from=admin&expense=${expense.id}`,
                                          );
                                          return;
                                        }
                                        setSelectedExpense(expense);
                                        setDialogOpen(true);
                                      }}
                                    >
                                      {expense.batch_id
                                        ? "Review batch"
                                        : (expense.status || "").toLowerCase() === "approved" ||
                                          (expense.status || "").toLowerCase() === "rejected"
                                          ? "View"
                                          : "View/Approve"}
                                    </Button>
                                  </div>
                                </div>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {filteredExpenses.length > 0 && (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs sm:text-sm text-gray-600">
                      Page {safeCurrentPage} of {totalPages}
                    </p>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                        disabled={safeCurrentPage === 1}
                      >
                        Prev
                      </Button>
                      {getVisiblePageNumbers().map((page, idx, pages) => {
                        const previous = pages[idx - 1];
                        const showEllipsis = previous !== undefined && page - previous > 1;
                        return (
                          <div key={`page-${page}`} className="flex items-center gap-1">
                            {showEllipsis && <span className="px-1 text-gray-400">...</span>}
                            <Button
                              variant={page === safeCurrentPage ? "default" : "outline"}
                              size="sm"
                              onClick={() => setCurrentPage(page)}
                              className="min-w-8 px-2"
                            >
                              {page}
                            </Button>
                          </div>
                        );
                      })}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                        disabled={safeCurrentPage === totalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
              );
            })()}

            {/* Review Expense Dialog - single instance outside table for reliable rendering */}
            <Dialog open={dialogOpen} onOpenChange={(open) => {
              setDialogOpen(open);
              if (!open) {
                setSelectedExpense(null);
                setAdminComment("");
                setSelectedStatus("");
              }
            }}>
              <DialogContent className="max-w-[95vw] sm:max-w-2xl md:max-w-4xl max-h-[95vh] sm:max-h-[85vh] overflow-hidden flex flex-col p-0">
                <div ref={reviewDialogContentRef} className="overflow-y-auto flex-1 p-4 sm:p-6 min-h-0">
                  <DialogHeader>
                    <DialogTitle>Review and manage this expense submission</DialogTitle>
                  </DialogHeader>

                  {selectedExpense && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-medium">Employee</label>
                          <p className="text-sm">{selectedExpense.user_name}</p>
                          <p className="text-xs text-muted-foreground">{selectedExpense.user_email}</p>
                        </div>
                        <div>
                          <label className="text-sm font-medium">Amount</label>
                          <p className="text-lg font-semibold">{formatINR(selectedExpense.total_amount)}</p>
                        </div>
                      </div>

                      {organizationId && (
                        <ExpenseBaseFieldsDisplay
                          organizationId={organizationId}
                          values={{
                            title: selectedExpense.title,
                            destination: selectedExpense.destination,
                            category: selectedExpense.category,
                            purpose: selectedExpense.purpose,
                            expense_date: format(
                              parseLocalDate(selectedExpense.trip_start) ?? new Date(selectedExpense.trip_start),
                              "MMM d, yyyy",
                            ),
                          }}
                          context="review"
                          className="space-y-3"
                        />
                      )}

                      <div>
                        <label className="text-sm font-medium">Current Status</label>
                        <div className="mt-1">
                          <ExpenseStatusWithCorrectionBadge
                            status={selectedExpense.status}
                            wasReviewerCorrected={selectedExpense.wasReviewerCorrected}
                            viewerContext="reviewer"
                          />
                        </div>
                      </div>

                      {reviewExpense && organizationId && (
                        <ExpenseFormFieldsDisplay
                          key={`${reviewExpense.id}-${Object.keys(reviewExpense.custom_fields ?? {}).sort().join(",")}`}
                          expenseId={reviewExpense.id}
                          organizationId={organizationId}
                          context="review"
                          prefetchedFields={reviewExpense.custom_fields}
                          className="space-y-3 pt-2 border-t"
                        />
                      )}

                      {/* For submitted or adjusted expenses, show admin comment + actions */}
                      {selectedExpense.status === "submitted" || selectedExpense.status === "edited" ? (
                        <div>
                          <label className="text-sm font-medium">Admin Comment (Optional)</label>
                          <Textarea
                            value={adminComment}
                            onChange={(e) => setAdminComment(e.target.value)}
                            placeholder="Add a comment about this expense..."
                            className="mt-1"
                          />
                        </div>
                      ) : isAdminApprovableStatus(selectedExpense.status) &&
                        !["submitted", "edited"].includes(selectedExpense.status) ? (
                        <div>
                          <label className="text-sm font-medium">Admin Comment (Optional)</label>
                          <Textarea
                            value={adminComment}
                            onChange={(e) => setAdminComment(e.target.value)}
                            placeholder="Add a comment about this expense..."
                            className="mt-1"
                          />
                        </div>
                      ) : (
                        <>
                          <div>
                            <label className="text-sm font-medium">Update Status</label>
                            <Select
                              value={selectedStatus}
                              onValueChange={setSelectedStatus}
                              disabled={selectedExpense.status === 'approved'}
                            >
                              <SelectTrigger className="mt-1">
                                <SelectValue placeholder="Select new status" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="submitted">Submitted</SelectItem>
                                <SelectItem value="verified">Verified</SelectItem>
                                <SelectItem value="approved">Approved</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div>
                            <label className="text-sm font-medium">Admin Comment</label>
                            <Textarea
                              value={adminComment}
                              onChange={(e) => setAdminComment(e.target.value)}
                              placeholder="Add a comment about this expense..."
                              className="mt-1"
                            />
                          </div>
                        </>
                      )}

                      {attachments.length > 0 && (
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Receipts & Attachments</label>
                          <div className="space-y-2">
                            {attachments.map((a) => (
                              <div key={a.id} className="flex items-center justify-between p-3 border rounded-lg">
                                <div className="flex items-center gap-3">
                                  {a.content_type?.startsWith("image/") ? (
                                    <AttachmentThumbnail
                                      fileUrl={a.file_url}
                                      contentType={a.content_type}
                                      alt={a.filename}
                                      className="h-14 w-14 shrink-0"
                                      uploadedBy={selectedExpense?.user_id}
                                      expenseId={selectedExpense?.id ?? null}
                                    />
                                  ) : (
                                    <div className="h-14 w-14 flex items-center justify-center bg-gray-100 rounded text-xs">FILE</div>
                                  )}
                                  <div>
                                    <p className="font-medium text-sm">{a.filename}</p>
                                    <p className="text-xs text-muted-foreground">{a.content_type} • {format(new Date(a.created_at), "MMM d, yyyy")}</p>
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    setImagePreviewUrl(a.file_url);
                                    setPreviewContentType(a.content_type);
                                    setPreviewUploadedBy(selectedExpense?.user_id ?? null);
                                    setImagePreviewOpen(true);
                                  }}
                                >
                                  View
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {correctionLogs.length > 0 && (
                        <div className="space-y-2 border-t pt-4 mt-4">
                          <label className="text-sm font-medium">Reviewer corrections (audit)</label>
                          <ExpenseCorrectionAuditList logs={correctionLogs} maxHeightClassName="max-h-72" />
                        </div>
                      )}

                      {selectedExpense ? (
                        <div className="space-y-2 border-t pt-4 mt-4">
                          <label className="text-sm font-medium">
                            {t("admin:review.timeline.title", {
                              defaultValue: "Review timeline",
                            })}
                          </label>
                          <ExpenseReviewTimeline
                            expense={{
                              status: selectedExpense.status,
                              approval_tier: selectedExpense.approval_tier,
                              assigned_reviewer_id:
                                selectedExpense.assigned_reviewer_id,
                              assigned_engineer_id:
                                selectedExpense.assigned_engineer_id,
                              created_at: selectedExpense.created_at,
                              updated_at: selectedExpense.updated_at,
                            }}
                            auditLogs={auditLogs}
                            correctionLogs={correctionLogs}
                            hierarchy={{
                              enabled: hierarchyEnabled,
                              teamLeader: teamLeaderTierEnabled,
                              executive: executiveTierEnabled,
                            }}
                            roleLabels={roleLabels}
                            assigneeNames={timelineAssignees}
                          />
                        </div>
                      ) : null}
                    </div>
                  )}

                  <DialogFooter className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:justify-end">
                    <Button variant="outline" onClick={() => {
                      setDialogOpen(false);
                      setSelectedExpense(null);
                      setAdminComment("");
                      setSelectedStatus("");
                    }}>
                      Cancel
                    </Button>
                    {canReviewerCorrectExpense(selectedExpense) ? (
                      <Button type="button" variant="secondary" onClick={openCorrectionDialog}>
                        Correct expense
                      </Button>
                    ) : null}
                    {selectedExpense?.status === "rejected" ? (
                      null
                    ) : selectedExpense?.status === "submitted" || selectedExpense?.status === "edited" ? (
                      <>
                        <Button
                          variant="destructive"
                          onClick={rejectExpense}
                          disabled={reviewLoading || selectedExpense?.status === 'approved' || selectedExpense?.status === 'rejected'}
                        >
                          Reject
                        </Button>
                        <Button variant="outline" onClick={verifyExpense}>
                          Verify
                        </Button>
                        <Button onClick={approveExpenseDirect}>
                          Approve
                        </Button>
                      </>
                    ) : selectedExpense &&
                      isAdminApprovableStatus(selectedExpense.status) &&
                      !["submitted", "edited"].includes(selectedExpense.status) ? (
                      <>
                        <Button
                          variant="destructive"
                          onClick={rejectExpense}
                          disabled={reviewLoading || selectedExpense?.status === 'approved' || selectedExpense?.status === 'rejected'}
                        >
                          Reject
                        </Button>
                        <Button onClick={approveExpenseDirect}>
                          Approve
                        </Button>
                      </>
                    ) : (
                      <Button
                        onClick={updateExpenseStatus}
                        disabled={!selectedStatus || selectedExpense?.status === 'approved'}
                      >
                        Update Status
                      </Button>
                    )}
                  </DialogFooter>
                </div>
              </DialogContent>
            </Dialog>

            <Dialog open={correctionDialogOpen} onOpenChange={setCorrectionDialogOpen}>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Correct expense (on behalf of employee)</DialogTitle>
                  <DialogDescription>
                    Saves a before/after audit record and sets status to Adjusted. The employee continues to see this as submitted while in review.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-2">
                  <div>
                    <Label htmlFor="corr-title">{getBaseFieldLabel("title")}</Label>
                    <Input id="corr-title" value={corrTitle} onChange={(e) => setCorrTitle(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="corr-dest">{getBaseFieldLabel("destination")}</Label>
                    <Input id="corr-dest" value={corrDestination} onChange={(e) => setCorrDestination(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="corr-date">{getBaseFieldLabel("expense_date")}</Label>
                    <Input id="corr-date" type="date" value={corrExpenseDate} onChange={(e) => setCorrExpenseDate(e.target.value)} />
                    <p className="text-xs text-muted-foreground mt-1">
                      Same as the employee expense form — one date is stored for this expense.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="corr-pur">{getBaseFieldLabel("purpose")}</Label>
                    <Textarea id="corr-pur" value={corrPurpose} onChange={(e) => setCorrPurpose(e.target.value)} rows={2} />
                  </div>
                  <div>
                    <Label htmlFor="corr-cat">{getBaseFieldLabel("category")}</Label>
                    <ExpenseCategorySelect
                      id="corr-cat"
                      organizationId={organizationId}
                      value={corrCategory}
                      onChange={setCorrCategory}
                    />
                  </div>
                  <div>
                    <Label htmlFor="corr-amt">{getBaseFieldLabel("amount")}</Label>
                    <Input id="corr-amt" type="number" min={0} step="0.01" value={corrAmount} onChange={(e) => setCorrAmount(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="corr-ac">Admin comment (stored on expense)</Label>
                    <Textarea id="corr-ac" value={corrAdminComment} onChange={(e) => setCorrAdminComment(e.target.value)} rows={2} />
                  </div>
                  {corrFieldModel.loadError && (
                    <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      {corrFieldModel.loadError}
                    </p>
                  )}
                  <CorrectionCustomFieldsSection
                    categoryFormFields={corrFieldModel.categoryFormFields}
                    formFieldValues={corrFieldModel.formFieldValues}
                    onFormFieldValuesChange={(vals) =>
                      setCorrFieldModel((prev) => ({ ...prev, formFieldValues: vals }))
                    }
                    optionBranches={corrFieldModel.optionBranches}
                    branchValues={corrFieldModel.branchValues}
                    onBranchValuesChange={(vals) =>
                      setCorrFieldModel((prev) => ({ ...prev, branchValues: vals }))
                    }
                    allowNested={allowNestedConditional}
                    organizationId={organizationId}
                    onSelectOptionValue={handleCorrectionSelectOptionValue}
                  />
                  <div>
                    <Label htmlFor="corr-reason">Reason for correction (audit)</Label>
                    <Textarea id="corr-reason" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} rows={2} placeholder="Optional note explaining the change" />
                  </div>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setCorrectionDialogOpen(false)} disabled={correctionLoading}>
                    Cancel
                  </Button>
                  <Button onClick={() => void submitExpenseCorrection()} disabled={correctionLoading}>
                    {correctionLoading ? "Saving…" : "Save correction"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

          </CardContent>
        </Card>
        <AttachmentPreviewDialog
          open={imagePreviewOpen}
          onOpenChange={setImagePreviewOpen}
          url={imagePreviewUrl}
          contentType={previewContentType}
          uploadedBy={previewUploadedBy}
          expenseId={selectedExpense?.id ?? null}
        />
      </div>
    </div>
  );
}
