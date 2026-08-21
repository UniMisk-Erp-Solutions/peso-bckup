import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Receipt,
  CheckCircle,
  XCircle,
  Clock,
  Coins,
  Eye,
  FileText,
  User,
  Search,
  Calendar,
  Download,
  ExternalLink
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ExpenseService, type BatchVerifyResult, type BatchVerifyBlocker } from "@/services/ExpenseService";
import { waitingReasonLabel } from "@/lib/reviewWaitingReason";
import { format, subDays, subMonths, subYears } from "date-fns";
import { formatINR, formatCreatedDateTime, parseLocalDate } from "@/lib/format";
import { getDateLocale } from "@/lib/formatLocale";
import { enrichAuditLogsWithDisplay, type EnrichedAuditLog } from "@/lib/auditLogDisplay";
import { ExpenseCorrectionAuditList } from "@/components/ExpenseCorrectionAudit";
import { ExpenseReviewTimeline } from "@/components/ExpenseReviewTimeline";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import type { ExpenseCorrectionLogEntry } from "@/lib/expenseCorrectionAudit";
import { normalizeReceiptPublicUrl } from "@/lib/attachmentPreview";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  batchReviewState,
  isTerminalReviewStatus,
  reviewRowState,
  reviewStatePresentation,
  type ReviewRowState,
} from "@/lib/reviewStatePresentation";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { canRoleApprove, getRoleLabel } from "@/lib/approvalHierarchy";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { ExpenseFormFieldsDisplay } from "@/components/ExpenseFormFieldsDisplay";
import { ExpenseBaseFieldsDisplay } from "@/components/ExpenseBaseFieldsDisplay";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import { AttachmentPreviewDialog } from "@/components/AttachmentPreviewDialog";
import { ExpenseCustomFieldFilters } from "@/components/ExpenseCustomFieldFilters";
import {
  fetchExpenseCustomFieldsMap,
  matchesCustomFieldFilters,
  mergeFilterableFieldsWithEmployeeData,
} from "@/lib/expenseCustomFieldFilters";
import { useExpenseCustomFieldFilters } from "@/hooks/useExpenseCustomFieldFilters";
import {
  fetchManagerReviewerExpenses,
} from "@/lib/managerReviewExpenses";
import { isSkippedHierarchyTier } from "@/lib/managerActionableExpenses";
import { fetchExpenseSubmitterProfiles, fetchProfilesByUserIds, fetchResubmittedExpenseIds, resolveSubmitterEmployeeId } from "@/lib/supabaseInQuery";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ReviewIdentityStore, applyReviewRowIdentity } from "@/lib/reviewIdentityCache";
import { useManagerOverrideCapability } from "@/lib/reviewManagerOverrideCapability";
import {
  type AppliedReviewQuery,
  type ReviewCustomFilterRecord,
  appliedSortToServerSort,
  buildAppliedQueryKey,
  customFilterRecordToServer,
  defaultAppliedReviewQuery,
  deriveDateRange,
  isServerQueryActive,
  statusToServerStatuses,
  type CustomFieldResolver,
} from "@/lib/reviewAppliedQuery";
import {
  SERVER_QUERY_PAGE_SIZE,
  SERVER_QUERY_TIMEOUT_MS,
  fetchServerQueryPage,
  fetchServerQueryPageByNumber,
  newCursorHistory,
  recordCursor,
  totalPagesFor,
  type CursorHistory,
  type ServerQueryPage,
  type ServerQueryParams,
} from "@/lib/reviewServerPagination";
import { fetchReviewQueueFilterOptions } from "@/features/reviewQueueServer/api";
import type { ReviewQueueCursor } from "@/features/reviewQueueServer/types";
import {
  REVIEW_WORKSPACE_VERSION,
  type ReviewWorkspaceState,
  clampRestoredPage,
  clearReviewWorkspaceState,
  consumeReviewReturnPending,
  loadReviewWorkspaceState,
  markReviewReturnPending,
  saveReviewWorkspaceState,
} from "@/lib/reviewWorkspaceState";
import {
  REVIEW_RETURN_CACHE_VERSION,
  clearReviewReturnCache,
  loadReviewReturnCache,
  saveReviewReturnCache,
} from "@/lib/reviewReturnCache";
import {
  type ApprovalClassification,
  type SelectableRow,
  classifyForApproval,
  expandSelectionToExpenseIds,
  isRowSelectable,
  needsApprovalWarning,
  pageSelectableKeys,
  selectAllState,
  selectionKey,
  splitSelectedKeys as splitSelectedKeysBySelection,
} from "@/lib/reviewBulkSelection";
import {
  fetchHierarchyReviewerExpenses,
  type HierarchyReviewerExpenseRow,
} from "@/lib/hierarchyReviewExpenses";
import {
  loadLegacyReviewPages,
  initLegacyCursors,
  legacyCursorsComplete,
  HIERARCHY_LEGACY_SOURCES,
  MANAGER_LEGACY_SOURCES,
  LEGACY_INITIAL_ROWS,
  type LegacySourceCursor,
} from "@/lib/legacyReviewPagination";
import {
  fetchReviewerVisibleCount,
  loadReviewerExpensePages,
  isTrulyComplete,
  REVIEW_SERVER_PAGE_SIZE,
  type ReviewCursor,
} from "@/lib/reviewExpensePagination";
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
import { expenseRowMatchesSearch } from "@/lib/expenseListSearch";
import { useSingleBarSearch } from "@/features/reviewQueueServer/hooks/useSingleBarSearch";
import type { SearchResolution } from "@/features/reviewQueueServer/hooks/useSingleBarSearch";
import { ReviewSearchBar } from "@/features/reviewExpensesServer/ReviewSearchBar";
import { ReviewEmployeeResultsPopover } from "@/features/reviewExpensesServer/ReviewEmployeeResultsPopover";
import { useOrganizationIdentityMode } from "@/hooks/useOrganizationIdentityMode";
import { getOrgSettings } from "@/lib/orgSettingsCache";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileReviewQueueView } from "@/components/mobile/MobileReviewQueueView";
import { MobileReviewDetailView } from "@/components/mobile/MobileReviewDetailView";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { useResizableColumns, resizeHandleClass } from "@/hooks/useResizableColumns";

export interface Expense {
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
  user_employee_id?: string;
  user_balance: number;
  purpose?: string;
  admin_comment?: string;
  category?: string | null;
  assigned_engineer_id?: string | null;
  assigned_reviewer_id?: string | null;
  approval_tier?: string | null;
  wasReviewerCorrected?: boolean;
  batch_id?: string | null;
  custom_fields?: Record<string, string>;
  manager_queue_ready?: boolean;
}

// Local state for image preview

interface LineItem {
  id: string;
  date: string;
  category: string;
  amount: number;
  description: string;
}

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  file_url: string;
  created_at: string;
}

const REVIEW_PAGE_SIZE = 25;
const REVIEW_INITIAL_FETCH_LIMIT = 300;
/** Server pages pulled before the initial load stops and waits for "Load All". */
const REVIEW_INITIAL_PAGE_COUNT = 2;

/**
 * Cache schema version.
 *
 * v2 entries are NOT readable here: they stored at most 200 rows while still
 * being able to claim `allLoaded: true`, and they predate the keyset cursor
 * contract. Trusting one would make the page believe a 200-row slice was the
 * complete 6,088-row data set. Bumping the key abandons them.
 */
// v4: cached rows now carry hydrated employee identity (name/employee ID/balance).
// v3 and earlier snapshots stored identity-less rows and would flash "—" on
// restore, so the bump abandons them and forces one identity-hydrated fetch.
const REVIEW_CACHE_VERSION = "pesowise-review-v4";
/** Bumped whenever the server-side visibility scope changes shape. */
const REVIEW_SCOPE_VERSION = "reviewer-visible-v1";

type ReviewListCacheEntry = {
  expenses: Expense[];
  complete: boolean;
  totalAvailable: number | null;
  cachedAt: number;
  truncated: boolean;
  nextCursor: ReviewCursor | null;
  organizationId: string;
  userId: string;
  scopeVersion: string;
};

const reviewListCache = new Map<string, ReviewListCacheEntry>();

function buildReviewStorageKey(userId: string, organizationId: string): string {
  return `${REVIEW_CACHE_VERSION}:${userId}:${organizationId}`;
}

/**
 * Which pagination contract the page is operating under.
 *
 * `null` = not yet detected. This is deliberately explicit rather than inferred
 * from `nextCursor`: a null cursor is ambiguous (it means "exhausted" in
 * canonical mode but "not applicable" in legacy mode), and reading it as
 * "exhausted" is what made Load All a silent no-op without the SQL installed.
 */
type ReviewPaginationMode = "canonical" | "legacy" | null;

/**
 * Session-scoped memo of whether the canonical RPCs exist, so a 404 is paid
 * once per session instead of on every Load All page. Not persisted to
 * localStorage — a deployment that installs the SQL must take effect on reload.
 */
const CANONICAL_CAPABILITY_KEY = "pesowise:review:canonical-pagination";

function readCanonicalCapability(): boolean | null {
  try {
    const v = sessionStorage.getItem(CANONICAL_CAPABILITY_KEY);
    return v === "true" ? true : v === "false" ? false : null;
  } catch {
    return null;
  }
}

function writeCanonicalCapability(available: boolean): void {
  try {
    sessionStorage.setItem(CANONICAL_CAPABILITY_KEY, String(available));
  } catch {
    /* storage unavailable — fall back to re-probing */
  }
}

/** Rows persisted to localStorage. Beyond this the entry is marked truncated. */
const REVIEW_CACHE_MAX_STORED_ROWS = 500;

/**
 * Persist a cache entry for instant repaint on the next visit.
 *
 * A stored slice smaller than the in-memory set is ALWAYS marked truncated, so a
 * partial cache can never come back claiming to be the complete data set.
 */
function persistReviewCache(entry: ReviewListCacheEntry): void {
  try {
    const stored = entry.expenses.slice(0, REVIEW_CACHE_MAX_STORED_ROWS);
    const truncated = entry.truncated || stored.length < entry.expenses.length;
    localStorage.setItem(
      buildReviewStorageKey(entry.userId, entry.organizationId),
      JSON.stringify({
        ...entry,
        expenses: stored,
        truncated,
        complete: entry.complete && !truncated,
      }),
    );
  } catch {
    /* quota or serialization failure must never break the page */
  }
}

/**
 * Map a raw expense row to the UI shape WITHOUT waiting for any enrichment.
 * Optional fields get safe placeholders and are filled in later, in place.
 */
function toCoreExpense(row: Record<string, unknown>): Expense {
  return {
    ...(row as unknown as Expense),
    user_name: "",
    user_email: "",
    user_employee_id: undefined,
    user_balance: 0,
    total_amount: Number(row.total_amount ?? 0),
    isResubmitted: false,
    wasReviewerCorrected: false,
    custom_fields: undefined,
    manager_queue_ready: Boolean(
      (row as { manager_queue_ready?: boolean }).manager_queue_ready,
    ),
  } as Expense;
}

function buildReviewListCacheKey(input: {
  userId: string;
  organizationId: string;
  userRole: string | null;
  timePeriod: string;
  isHierarchyReviewer: boolean;
  hierarchyEnabled: boolean;
  includeTeamLeaderReports: boolean;
  includeExecutiveReports: boolean;
}): string {
  return [
    input.userId,
    input.organizationId,
    input.userRole ?? "",
    input.timePeriod,
    input.isHierarchyReviewer ? "hr" : "eng",
    input.hierarchyEnabled ? "1" : "0",
    input.includeTeamLeaderReports ? "1" : "0",
    input.includeExecutiveReports ? "1" : "0",
  ].join("|");
}

export default function ManagerReview() {
  const { t, i18n } = useTranslation(["admin", "common", "expenses"]);
  const navigate = useNavigate();
  const { user, userRole, organizationId, organizationFeatureFlags, hasOrganizationFeature } =
    useAuth();
  const {
    filterableCustomFields,
    customFieldFilters,
    setCustomFieldFilters,
  } = useExpenseCustomFieldFilters(organizationId, { scanExpenseValues: false });
  const hierarchyEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.approval_hierarchy,
  );
  const teamsEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.teams_enabled,
  );
  const employeeIdLoginEnabled = hasOrganizationFeature(
    ORGANIZATION_FEATURE_KEYS.employee_id_login,
  );
  const { expenseSearchIdentityOptions } = useOrganizationIdentityMode();
  const teamLeaderTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_team_leader]);
  const executiveTierEnabled =
    hierarchyEnabled &&
    Boolean(organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.hierarchy_executive]);
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;
  const { roleLabels } = useOrganizationRoleLabels();
  const { getFieldLabel: getBaseFieldLabel } = useOrganizationExpenseFormConfig(organizationId);
  const { isMobile } = useViewportMode();
  const isHierarchyReviewer =
    userRole === "team_leader" || userRole === "executive";
  const canApprove = userRole ? canRoleApprove(userRole) : false;
  const { toast } = useToast();
  const moneyLocale = getDateLocale(i18n.language);

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  /** True only when refreshing in the background while cached rows are already visible */
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  /** Live row from expenses list (includes async custom_fields enrichment). */
  const reviewExpense = useMemo(() => {
    if (!selectedExpense) return null;
    return expenses.find((e) => e.id === selectedExpense.id) ?? selectedExpense;
  }, [selectedExpense, expenses]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [engineerComment, setEngineerComment] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false);
  const [imagePreviewOpen, setImagePreviewOpen] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [previewContentType, setPreviewContentType] = useState<string | null>(null);
  const [previewUploadedBy, setPreviewUploadedBy] = useState<string | null>(null);
  const [engineerApprovalLimit, setEngineerApprovalLimit] = useState<number>(50000);
  /**
   * True once the REAL organization approval limit has resolved. Until then the
   * default (50000) is a placeholder and must NOT gate an override approval — an
   * over-limit expense could otherwise be offered as approvable (§8).
   */
  const [approvalLimitLoaded, setApprovalLimitLoaded] = useState(false);
  /** Server capability: whether Manager-override support is installed (fail closed). */
  const { ready: managerOverrideReady } = useManagerOverrideCapability();
  const [timePeriod, setTimePeriod] = useState<string>("all");
  const [searchTerm, setSearchTerm] = useState<string>(
    () => sessionStorage.getItem("engineerReview:searchTerm") ?? "",
  );
  // Single-bar search (DOC-080 §7/§8): ONE input, two proven server searches
  // underneath. Employee lookup resolves an immutable user_id via the review RPC
  // (typing issues zero requests; "6174" resolves employee 6174, never txn
  // 06174); expense text runs as a separate general filter. Manager and
  // Executive share this one control. The resolved user_id filters rows by
  // expense.user_id, which needs no async name/ID enrichment.
  /** Set true by the Search coordinator when a submit is delegating to an async employee resolution. */
  const pendingSubmitCommitRef = useRef(false);
  const commitDraftFiltersRef = useRef<() => void>(() => {});
  const handleSearchResolved = useCallback((r: SearchResolution) => {
    // Mirror the resolved expense text into searchTerm so the existing filter,
    // the table match-highlight and session persistence keep working. Selecting
    // an employee supersedes any text filter.
    setSearchTerm(r.kind === "expense" ? r.query : "");
    // When this resolution is the tail of a Search submit (a new/changed search,
    // or a pick from the disambiguation popover), commit the STAGED draft filters
    // in the SAME render so the whole applied query transitions at once (§10/§29).
    if (pendingSubmitCommitRef.current) {
      pendingSubmitCommitRef.current = false;
      commitDraftFiltersRef.current();
    }
  }, []);
  const singleBar = useSingleBarSearch({
    organizationId: organizationId ?? null,
    onResolved: handleSearchResolved,
  });
  const selectedEmployeeUserId = singleBar.selectedEmployee?.user_id ?? null;
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showOnlyActionable, setShowOnlyActionable] = useState(false);
  const [managerFetchWarning, setManagerFetchWarning] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  /**
   * "The user asked to keep loading everything this session."
   *
   * This is a REQUEST, not a statement about the data. It must never be used to
   * initialise `allExpensesLoaded` — doing so told the page that 6,088 rows were
   * already present when nothing had been fetched yet.
   */
  const [loadAllRequested, setLoadAllRequested] = useState(
    () => sessionStorage.getItem("pesowise:load-all:review") === "true",
  );
  /** "Every authorized row is actually in memory." Only ever set from real data. */
  const [allExpensesLoaded, setAllExpensesLoaded] = useState(false);
  const [loadingAllExpenses, setLoadingAllExpenses] = useState(false);
  /** Server-reported total for this reviewer's scope; null when unavailable. */
  const [totalAvailable, setTotalAvailable] = useState<number | null>(null);
  /**
   * Authoritative filtered result count for the employee chip (§4). Sourced from
   * the queue RPC's filtered_total, NOT the employee-search response's
   * visible_expense_count. `null` = not yet known → the chip shows "counting…"
   * rather than a false "0 visible".
   */
  const [filteredResultCount, setFilteredResultCount] = useState<number | null>(null);
  /** Keyset cursor to resume from. Null means "start from the top" or "exhausted". */
  const [nextCursor, setNextCursor] = useState<ReviewCursor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Unique rows actually held. Tracked separately from `totalAvailable`. */
  const [loadedCount, setLoadedCount] = useState(0);
  const loadAllAbortRef = useRef<AbortController | null>(null);
  /**
   * At most ONE active core Review request for the current mode (§7/§20/§21).
   * Starting a new core query (normal or filtered) aborts the previous one so an
   * obsolete RPC is truly cancelled, not merely ignored by the fetchSeq guard.
   */
  const coreRequestAbortRef = useRef<AbortController | null>(null);
  /** Query key of the core request currently in flight — used to dedupe background refreshes. */
  const activeCoreQueryKeyRef = useRef<string | null>(null);
  /** Explicit pagination contract — never inferred from nextCursor. */
  const [paginationMode, setPaginationMode] = useState<ReviewPaginationMode>(null);
  /** Per-source legacy offsets. Only meaningful when paginationMode === "legacy". */
  const [legacyCursors, setLegacyCursors] = useState<LegacySourceCursor[]>([]);
  /** Dev-visible signal that the canonical RPC was missing and legacy paging was used. */
  const [usedLegacyFallback, setUsedLegacyFallback] = useState(false);

  const {
    progress: loadAllProgress,
    startOperation: startLoadAll,
    completeOperation: completeLoadAll,
  } = useOperationProgress();
  const prevLoadingAllRef = useRef<boolean>(false);
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortOrder, setSortOrder] = useState<string>("desc");
  const [includeTeamLeaderReports, setIncludeTeamLeaderReports] = useState(
    () => hierarchyEnabled && teamLeaderTierEnabled,
  );
  const [includeExecutiveReports, setIncludeExecutiveReports] = useState(
    () => hierarchyEnabled && executiveTierEnabled,
  );

  /* ------------------------------------------------------------------ *
   * Submit-driven query model (DOC-080 §6-§14).
   *
   * The state variables above (statusFilter, sortBy, sortOrder, timePeriod,
   * customFieldFilters, showOnlyActionable, includeTeamLeaderReports,
   * includeExecutiveReports) plus singleBar's employee/general search are the
   * APPLIED query — what the list actually reflects and what every fetch /
   * applyFilters / query-key / workspace path already reads. The DRAFT twins
   * below are what the filter CONTROLS write to; nothing observes them, so
   * changing Status / Sort / Time / custom filters issues ZERO requests and
   * leaves the table stable (§7/§31/§32). Pressing Search copies draft → applied
   * atomically and bumps `appliedRevision`, so exactly one coherent query runs
   * (§8/§29).
   * ------------------------------------------------------------------ */
  const [draftStatus, setDraftStatus] = useState("all");
  const [draftSortBy, setDraftSortBy] = useState("created_at");
  const [draftSortOrder, setDraftSortOrder] = useState("desc");
  const [draftTimePeriod, setDraftTimePeriod] = useState("all");
  const [draftShowOnlyActionable, setDraftShowOnlyActionable] = useState(false);
  const [draftIncludeTeamLeaderReports, setDraftIncludeTeamLeaderReports] = useState(false);
  const [draftIncludeExecutiveReports, setDraftIncludeExecutiveReports] = useState(false);
  const [draftCustomFieldFilters, setDraftCustomFieldFilters] = useState<ReviewCustomFilterRecord>({});
  /** Bumped once per Search submit; the core fetch effects key off it so an identical re-submit still runs exactly one query. */
  const [appliedRevision, setAppliedRevision] = useState(0);

  /* Server-query (true page-at-a-time) pagination state (§22-§27). Distinct from
   * the normal-mode client slice: in server-query mode allExpenses holds only the
   * current 25-row page and these drive the pager + counts. */
  const [serverPage, setServerPage] = useState(1);
  const [serverTotalPages, setServerTotalPages] = useState(0);
  const [serverFilteredSummary, setServerFilteredSummary] =
    useState<ServerQueryPage["filteredSummary"]>(null);
  /**
   * Set when a server-query page FAILS or TIMES OUT (not a silent supersession).
   * Drives the search chip out of the perpetual "counting…" state and shows a
   * visible retry, so a failed filtered search never looks like it did nothing (§27).
   */
  const [serverQueryError, setServerQueryError] = useState<string | null>(null);
  const serverCursorHistoryRef = useRef<CursorHistory>(newCursorHistory());
  const serverNextCursorRef = useRef<ReviewQueueCursor | null>(null);
  const serverPageRef = useRef(1);
  /** Resolver: custom-field display label → server {source, field_id}. Built from the queue filter-options RPC. */
  const customFieldResolverRef = useRef<CustomFieldResolver>(() => []);

  const [allExpenses, setAllExpenses] = useState<Expense[]>([]);
  const [auditLogs, setAuditLogs] = useState<EnrichedAuditLog[]>([]);
  const [timelineAssignees, setTimelineAssignees] = useState<{
    reviewer?: string | null;
    engineer?: string | null;
  }>({});
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [correctionLogs, setCorrectionLogs] = useState<ExpenseCorrectionLogEntry[]>([]);
  const [correctionReason, setCorrectionReason] = useState("");
  const [corrTitle, setCorrTitle] = useState("");
  const [corrDestination, setCorrDestination] = useState("");
  const [corrExpenseDate, setCorrExpenseDate] = useState("");
  const [corrPurpose, setCorrPurpose] = useState("");
  const [corrCategory, setCorrCategory] = useState("");
  const [corrAmount, setCorrAmount] = useState("");
  const [corrAdminComment, setCorrAdminComment] = useState("");
  const [corrFieldModel, setCorrFieldModel] = useState<CorrectionCustomFieldsModel>(EMPTY_CORRECTION_FIELDS);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  /**
   * Pre-approval warning: set when a bulk-approve selection contains rows that
   * are not immediately approvable (waiting at a later tier / over limit /
   * terminal). While set, NOTHING has been mutated — the dialog decides.
   */
  const [approvalWarning, setApprovalWarning] = useState<{
    classification: ApprovalClassification;
    selectedTotal: number;
    /** "single" = from an open expense's Approve; "bulk" = from the bulk bar. */
    mode: "single" | "bulk";
    /** Fresh-resolved rows behind the classification, for per-item detail (§7B). */
    targets: Expense[];
  } | null>(null);
  /** Whether the waiting-items detail list is expanded (§7E "View N waiting items"). */
  const [approvalWarningShowWaiting, setApprovalWarningShowWaiting] = useState(false);
  /** Second explicit confirmation gate before ANY override RPC runs (§7G). */
  const [overrideConfirmOpen, setOverrideConfirmOpen] = useState(false);
  /**
   * Per-batch blocker detail from the last Bulk Verify run (DOC-098 §5B) —
   * shown instead of an aggregate-only "N failed" toast. Cleared on dismiss;
   * NOTHING was mutated for a blocked batch.
   */
  const [batchVerifyBlockers, setBatchVerifyBlockers] = useState<
    Array<{ batchId: string; blockers: BatchVerifyBlocker[] }>
  >([]);

  const fetchSeqRef = useRef(0);
  /** Expense ids whose optional badges (resubmitted/corrected/custom) were requested. */
  const enrichedIdsRef = useRef<Set<string>>(new Set());
  /** Monotonic counter used to drop stale OPTIONAL-badge responses (never identity). */
  const enrichSeqRef = useRef(0);
  /**
   * Employee identity (name/employee ID/balance) is CORE row data, resolved by a
   * dedicated user_id-keyed store that never discards a fetched profile because a
   * later render happened — the bug that stuck names on "—". Held in a ref so it
   * survives re-renders; patched into rows via `applyReviewRowIdentity`.
   */
  const identityStoreRef = useRef(new ReviewIdentityStore());
  /** Bumped whenever identities newly resolve, so the patch effect re-applies them. */
  const [identityVersion, setIdentityVersion] = useState(0);
  /** True while the component is mounted — gates setState after an async identity fetch. */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** True when some optional detail could not be loaded (rows still shown). */
  const [enrichmentDegraded, setEnrichmentDegraded] = useState(false);
  /** True when employee identity could not be resolved for some visible rows. */
  const [identityDegraded, setIdentityDegraded] = useState(false);

  /**
   * Resolve identity for a page's rows and return them WITH identity applied,
   * BEFORE the caller commits them to visible state. This is what guarantees a
   * row with a valid user_id never first renders "—" and then populates: the
   * fetch pipeline awaits this per page, so the first visible commit already
   * carries names, employee IDs and balances.
   *
   * It blocks only on the light org-scoped `profiles` lookup (a page's ~10-25
   * unique users), never the heavy custom-field enrichment. On failure it still
   * returns the rows (degraded hint shown, retry on refetch) rather than hang.
   */
  const hydrateRowsIdentity = useCallback(
    async (rows: Expense[]): Promise<Expense[]> => {
      if (!organizationId || rows.length === 0) return rows;
      const userIds = new Set<string>();
      for (const r of rows) if (r.user_id) userIds.add(r.user_id);
      const need = identityStoreRef.current.pending(userIds);
      if (need.length > 0) {
        const { failed } = await identityStoreRef.current.resolve(need, (ids) =>
          fetchExpenseSubmitterProfiles(supabase, organizationId, ids),
        );
        if (failed.length > 0 && mountedRef.current) setIdentityDegraded(true);
      }
      return rows.map((row) =>
        applyReviewRowIdentity(row, identityStoreRef.current, resolveSubmitterEmployeeId),
      );
    },
    [organizationId],
  );

  const debouncedRefetchRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Page + scroll restoration: track user-driven filter changes vs data reloads
  const prevUserFiltersKeyRef = useRef<string | null>(null);
  const pageRestoredRef = useRef(false);
  const [shouldRestoreScroll, setShouldRestoreScroll] = useState(false);
  const fetchAssignedExpensesRef = useRef<
    (options?: { background?: boolean }) => Promise<void>
  >(async () => { });
  const fetchFilteredExpensesRef = useRef<
    (options?: { background?: boolean }) => Promise<void>
  >(async () => { });
  /** Latest committed filter mode, read by refresh triggers that run in stale closures. */
  const reviewFilterActiveRef = useRef(false);
  const refreshCurrentReviewQueryRef = useRef<(options?: { background?: boolean }) => Promise<void>>(
    async () => {},
  );
  const employeeIdsRef = useRef<string[]>([]);

  /**
   * Debounced, SINGLE-FLIGHT background refresh routed through the current-query
   * dispatcher (§30). A realtime burst schedules exactly one refresh, and it
   * refreshes whatever query the user is actually looking at — never the full
   * normal scope while a filtered search is active.
   */
  const scheduleBackgroundRefetch = () => {
    if (debouncedRefetchRef.current) clearTimeout(debouncedRefetchRef.current);
    debouncedRefetchRef.current = setTimeout(() => {
      refreshCurrentReviewQueryRef.current({ background: true });
    }, 2500);
  };

  const { colWidth: reviewColWidth, startResize: reviewStartResize } = useResizableColumns(
    "pw_engineer_review_cols",
    {
      txn: 90,
      employee: 220,
      title: 130,
      category: 120,
      destination: 140,
      amount: 110,
      balance: 110,
      status: 120,
      expense_date: 130,
      date_created: 130,
    },
  );

  const displayFilterableCustomFields = useMemo(() => {
    const filled: Record<string, Set<string>> = {};
    for (const expense of allExpenses) {
      for (const [key, rawValue] of Object.entries(expense.custom_fields ?? {})) {
        const value = String(rawValue ?? "").trim();
        if (!value) continue;
        if (!filled[key]) filled[key] = new Set();
        filled[key].add(value);
      }
    }
    return mergeFilterableFieldsWithEmployeeData(filterableCustomFields, filled);
  }, [filterableCustomFields, allExpenses]);

  useEffect(() => {
    if (hierarchyEnabled && teamLeaderTierEnabled) {
      setIncludeTeamLeaderReports(true);
    }
    if (hierarchyEnabled && executiveTierEnabled) {
      setIncludeExecutiveReports(true);
    }
  }, [hierarchyEnabled, teamLeaderTierEnabled, executiveTierEnabled]);

  useEffect(() => {
    if ((userRole === "engineer" || isHierarchyReviewer) && organizationId) {
      void fetchEngineerApprovalLimit();
    }
  }, [userRole, organizationId, isHierarchyReviewer]);

  /**
   * The APPLIED query as one object (derived from the committed state above +
   * singleBar). Draft controls do NOT feed this — only Search does.
   */
  const appliedQuery: AppliedReviewQuery = useMemo(
    () => ({
      employeeUserId: singleBar.selectedEmployee?.user_id ?? null,
      employeeDisplay: singleBar.selectedEmployee
        ? {
            userId: singleBar.selectedEmployee.user_id,
            name: singleBar.selectedEmployee.employee_name,
            employeeId: singleBar.selectedEmployee.employee_id,
            email: null,
          }
        : null,
      generalSearch: singleBar.generalSearch,
      submittedSearch: singleBar.submitted,
      status: statusFilter,
      sortBy,
      sortOrder: sortOrder === "asc" ? "asc" : "desc",
      timePeriod,
      customFilters: customFieldFilters,
      showOnlyActionable,
      includeTeamLeaderReports,
      includeExecutiveReports,
      revision: appliedRevision,
    }),
    [
      singleBar.selectedEmployee,
      singleBar.generalSearch,
      singleBar.submitted,
      statusFilter,
      sortBy,
      sortOrder,
      timePeriod,
      customFieldFilters,
      showOnlyActionable,
      includeTeamLeaderReports,
      includeExecutiveReports,
      appliedRevision,
    ],
  );

  /**
   * THE broadened mode decision (§14). Server-query mode is active for ANY
   * applied server-supported modifier — employee, general search, a non-default
   * status (e.g. "Level 2 Verified" alone, the owner's exact bug), a non-default
   * sort, a non-"all" time period, or any custom filter. `reviewFilterActive` is
   * kept as the name every existing guard / effect dep / ref already uses, so the
   * broadening flows through the whole page without touching those call sites.
   */
  const serverQueryActive = useMemo(() => isServerQueryActive(appliedQuery), [appliedQuery]);
  /** Stable identity of the applied server query (excludes revision). */
  const appliedQueryKey = useMemo(() => buildAppliedQueryKey(appliedQuery), [appliedQuery]);
  /** True when any staged draft control differs from the applied query (§33 unsaved indicator). */
  const draftDiffersFromApplied = useMemo(
    () =>
      draftStatus !== statusFilter ||
      draftSortBy !== sortBy ||
      draftSortOrder !== sortOrder ||
      draftTimePeriod !== timePeriod ||
      draftShowOnlyActionable !== showOnlyActionable ||
      draftIncludeTeamLeaderReports !== includeTeamLeaderReports ||
      draftIncludeExecutiveReports !== includeExecutiveReports ||
      JSON.stringify(draftCustomFieldFilters) !== JSON.stringify(customFieldFilters) ||
      singleBar.draft.trim() !== (singleBar.submitted ?? "").trim(),
    [
      draftStatus,
      draftSortBy,
      draftSortOrder,
      draftTimePeriod,
      draftShowOnlyActionable,
      draftIncludeTeamLeaderReports,
      draftIncludeExecutiveReports,
      draftCustomFieldFilters,
      statusFilter,
      sortBy,
      sortOrder,
      timePeriod,
      showOnlyActionable,
      includeTeamLeaderReports,
      includeExecutiveReports,
      customFieldFilters,
      singleBar.draft,
      singleBar.submitted,
    ],
  );
  const reviewFilterActive = serverQueryActive;
  reviewFilterActiveRef.current = reviewFilterActive;
  const appliedQueryRef = useRef(appliedQuery);
  appliedQueryRef.current = appliedQuery;

  /**
   * Mirror the draft twins to the applied query whenever the applied query
   * changes through a NON-draft path: mount, hierarchy auto-enable, workspace
   * restore, or a Search commit. Draft edits never change these applied values,
   * so this can never clobber an in-progress edit — it only resets the controls'
   * baseline so the "unsaved filters" indicator (§33) is accurate.
   */
  useEffect(() => {
    setDraftStatus(statusFilter);
    setDraftSortBy(sortBy);
    setDraftSortOrder(sortOrder);
    setDraftTimePeriod(timePeriod);
    setDraftShowOnlyActionable(showOnlyActionable);
    setDraftIncludeTeamLeaderReports(includeTeamLeaderReports);
    setDraftIncludeExecutiveReports(includeExecutiveReports);
    setDraftCustomFieldFilters(customFieldFilters);
  }, [
    statusFilter,
    sortBy,
    sortOrder,
    timePeriod,
    showOnlyActionable,
    includeTeamLeaderReports,
    includeExecutiveReports,
    customFieldFilters,
  ]);

  /**
   * Build the custom-field resolver from the server's own filter-options so an
   * applied custom filter (keyed by display label in the legacy UI) can be sent
   * as `p_custom_filters` (§19). One request per org; failure leaves the resolver
   * empty (the broadened mode + enrichment guard still guarantee zero client
   * `expense_form_field_values` traffic).
   */
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void fetchReviewQueueFilterOptions(organizationId)
      .then((opts) => {
        if (cancelled) return;
        const byLabel = new Map<string, { source: "template" | "branch"; field_id: string }[]>();
        for (const f of opts.custom_fields) {
          const source: "template" | "branch" = f.source === "branch" ? "branch" : "template";
          const ref = { source, field_id: f.field_id };
          for (const raw of [f.label, f.field_key]) {
            const key = String(raw ?? "").trim().toLowerCase();
            if (!key) continue;
            const arr = byLabel.get(key) ?? [];
            if (!arr.some((r) => r.source === ref.source && r.field_id === ref.field_id)) {
              arr.push(ref);
            }
            byLabel.set(key, arr);
          }
        }
        customFieldResolverRef.current = (label: string) =>
          byLabel.get(String(label).trim().toLowerCase()) ?? [];
      })
      .catch(() => {
        /* resolver stays empty — never a user-facing error */
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  useEffect(() => {
    if (userRole !== "engineer" && !isHierarchyReviewer) return;
    // In FILTERED mode the filtered effect owns the fetch — the normal full-scope
    // fetch must not run (it would clobber the filtered rows and reload ~9,244).
    // When the filter clears this effect re-runs (deps include the filter) and
    // reloads normal mode.
    if (reviewFilterActive) return;
    // Debounce: multiple async flags (hierarchyEnabled, includeTeamLeaderReports, etc.) load
    // in rapid succession on mount, each changing a dep and re-running this effect.
    // 150ms cooldown collapses all of them into a single fetch.
    const t = setTimeout(() => {
      void fetchAssignedExpenses();
    }, 150);
    return () => clearTimeout(t);
  }, [
    user?.id,
    organizationId,
    userRole,
    timePeriod,
    reviewFilterActive,
    isHierarchyReviewer,
    hierarchyEnabled,
    teamsEnabled,
    includeTeamLeaderReports,
    includeExecutiveReports,
    teamLeaderTierEnabled,
    executiveTierEnabled,
  ]);

  // SERVER-QUERY mode fetch: page-at-a-time (§22-§30). Fires ONCE per APPLIED
  // query transition (a Search submit bumps appliedRevision) — never while the
  // reviewer is editing draft controls. A new applied shape invalidates the
  // cursor history; the fetch lands on the current server page (page 1 for a new
  // submit, the restored page on a workspace return).
  useEffect(() => {
    if (userRole !== "engineer" && !isHierarchyReviewer) return;
    if (!reviewFilterActive) return;
    serverCursorHistoryRef.current = newCursorHistory();
    serverNextCursorRef.current = null;
    const t = setTimeout(() => {
      void fetchServerPageInternal(serverPageRef.current);
    }, 100);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    reviewFilterActive,
    appliedQueryKey,
    appliedRevision,
    organizationId,
    user?.id,
    userRole,
    isHierarchyReviewer,
  ]);

  useEffect(() => {
    if (!user?.id || (userRole !== "engineer" && !isHierarchyReviewer)) return;

    const loadEmployeeIds = async () => {
      const { data: employeeProfiles } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("reporting_engineer_id", user.id);
      employeeIdsRef.current = (employeeProfiles || []).map((p) => p.user_id);
    };

    void loadEmployeeIds();

    const channel = supabase
      .channel(`engineer-expenses-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "expenses",
        },
        (payload) => {
          const newExpense = payload.new as {
            user_id?: string;
            assigned_engineer_id?: string | null;
            assigned_reviewer_id?: string | null;
            status?: string;
          };

          const relevant =
            (newExpense.user_id && employeeIdsRef.current.includes(newExpense.user_id)) ||
            newExpense.assigned_engineer_id === user.id ||
            newExpense.assigned_reviewer_id === user.id;
          if (
            relevant &&
            (newExpense.status === "submitted" ||
              newExpense.status === "verified" ||
              newExpense.status === "edited")
          ) {
            scheduleBackgroundRefetch();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "expenses",
        },
        (payload) => {
          const updatedExpense = payload.new as {
            user_id?: string;
            assigned_engineer_id?: string | null;
            assigned_reviewer_id?: string | null;
          };

          const relevant =
            (updatedExpense.user_id && employeeIdsRef.current.includes(updatedExpense.user_id)) ||
            updatedExpense.assigned_engineer_id === user.id ||
            updatedExpense.assigned_reviewer_id === user.id;
          if (relevant) {
            scheduleBackgroundRefetch();
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const newNotif = payload.new as { type?: string };
          if (newNotif.type === "expense_submitted" || newNotif.type === "expense_assigned") {
            scheduleBackgroundRefetch();
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, organizationId, userRole, isHierarchyReviewer]);

  useEffect(() => {
    return () => {
      if (debouncedRefetchRef.current) clearTimeout(debouncedRefetchRef.current);
    };
  }, []);

  useEffect(() => {
    applyFilters(allExpenses);

    // Build a key of only user-driven filters (not allExpenses — data reloads shouldn't reset the page)
    const filtersKey = [searchTerm, selectedEmployeeUserId ?? "", statusFilter, sortBy, sortOrder, String(showOnlyActionable), JSON.stringify(customFieldFilters)].join("|");
    const userFilterChanged = prevUserFiltersKeyRef.current !== null && prevUserFiltersKeyRef.current !== filtersKey;
    prevUserFiltersKeyRef.current = filtersKey;

    if (userFilterChanged) {
      // User changed a filter — reset to page 1 as before
      setCurrentPage(1);
      setSelectedKeys(new Set());
    } else if (!pageRestoredRef.current && allExpenses.length > 0) {
      // First time we have data — restore saved page and trigger scroll restoration
      pageRestoredRef.current = true;
      const savedPage = Math.max(1, parseInt(sessionStorage.getItem("engineerReview:currentPage") ?? "1", 10) || 1);
      setCurrentPage(savedPage);
      setShouldRestoreScroll(true);
    }
    // Data reload with same filters and page already restored → don't reset page
  }, [searchTerm, selectedEmployeeUserId, statusFilter, sortBy, sortOrder, allExpenses, customFieldFilters, showOnlyActionable]);

  useEffect(() => {
    sessionStorage.setItem("engineerReview:searchTerm", searchTerm);
  }, [searchTerm]);

  /**
   * Restore the full Review workspace when RETURNING from a Review child flow
   * (Review Batch / expense) — same employee, search, filters, sort, page and
   * scroll (§10-§21). Gated on a one-shot return-intent marker so a fresh sidebar
   * visit starts clean and never traps the user in an old search (§22). Employee
   * identity is restored from the stored immutable user_id + validated display
   * identity — ZERO employee-search RPC (§14).
   */
  const restoredWorkspaceRef = useRef(false);
  const pendingRestoreRef = useRef<ReviewWorkspaceState | null>(null);
  useEffect(() => {
    if (restoredWorkspaceRef.current) return;
    if (!organizationId || !user?.id) return;
    restoredWorkspaceRef.current = true;
    if (!consumeReviewReturnPending()) return;
    const snap = loadReviewWorkspaceState(organizationId, user.id, Date.now());
    if (!snap) return;

    // Restore the whole APPLIED query — including the custom filters, actionable
    // and hierarchy toggles the return cache key now depends on (§36/§37).
    setStatusFilter(snap.query.statusFilter);
    setSortBy(snap.query.sortBy);
    setSortOrder(snap.query.sortOrder === "asc" ? "asc" : "desc");
    setTimePeriod(snap.query.timePeriod);
    setShowOnlyActionable(snap.query.showOnlyActionable);
    setIncludeTeamLeaderReports(snap.query.includeTeamLeaderReports);
    setIncludeExecutiveReports(snap.query.includeExecutiveReports);
    const restoredCustomFilters =
      (snap.query.customFilters as ReviewCustomFilterRecord | null) ?? {};
    setCustomFieldFilters(restoredCustomFilters);
    singleBar.restoreSearch({
      draft: snap.query.searchDraft,
      submitted: snap.query.submittedSearch,
      selectedEmployee: snap.query.employee
        ? {
            user_id: snap.query.employee.userId,
            employee_name: snap.query.employee.name,
            employee_id: snap.query.employee.employeeId,
            identity_source: "restored",
            identity_issue: null,
            visible_expense_count: 0,
            actionable_expense_count: 0,
          }
        : null,
      generalSearch: snap.query.generalSearch,
    });

    // Reconstruct the applied query to derive its mode + stable key.
    const restoredApplied = defaultAppliedReviewQuery({
      employeeUserId: snap.query.employee?.userId ?? null,
      generalSearch: snap.query.generalSearch,
      status: snap.query.statusFilter,
      sortBy: snap.query.sortBy,
      sortOrder: snap.query.sortOrder === "asc" ? "asc" : "desc",
      timePeriod: snap.query.timePeriod,
      customFilters: restoredCustomFilters,
      showOnlyActionable: snap.query.showOnlyActionable,
      includeTeamLeaderReports: snap.query.includeTeamLeaderReports,
      includeExecutiveReports: snap.query.includeExecutiveReports,
    });
    const restoredServerMode = isServerQueryActive(restoredApplied);
    // Land the server pager on the saved page — the server effect fetches exactly
    // that page (§55), not page 1.
    if (restoredServerMode) {
      serverPageRef.current = Math.max(1, snap.pagination.page);
      setServerPage(Math.max(1, snap.pagination.page));
    }

    // INSTANT REPAINT (§13/§14): if a valid return cache for this exact applied
    // query exists, paint its rows immediately and clear the full-screen loader.
    // The fetch effects then background-refresh the same query. Approval stays
    // server-authoritative regardless of cached status (§15).
    const rc = loadReviewReturnCache(organizationId, user.id, Date.now());
    if (rc && rc.queryKey === buildAppliedQueryKey(restoredApplied)) {
      const cachedRows = rc.rows as Expense[];
      setAllExpenses(cachedRows);
      setAllExpensesLoaded(rc.allExpensesLoaded);
      setTotalAvailable(rc.totalAvailable);
      setFilteredResultCount(rc.filteredResultCount);
      if (restoredServerMode) {
        setServerTotalPages(totalPagesFor(rc.totalAvailable ?? cachedRows.length, REVIEW_PAGE_SIZE));
      }
      applyFilters(cachedRows);
      setLoading(false);
    }

    // Apply the saved page + scroll once the (filtered or normal) data commits.
    pendingRestoreRef.current = snap;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, user?.id]);

  /** Scroll/anchor target carried from a workspace restore until rows are on screen. */
  const workspaceScrollRef = useRef<{ y: number; anchorExpenseId: string | null } | null>(null);

  // Apply the restored page (clamped to the fresh result) + scroll, AFTER the
  // data has committed and the filter effect has settled (§15/§16/§27). Runs last
  // so its page wins over the filter effect's page-1 reset on a query change.
  useEffect(() => {
    const snap = pendingRestoreRef.current;
    if (!snap) return;
    if (loading) return;
    const expectsData = reviewFilterActive || Boolean(snap.query.employee || snap.query.generalSearch);
    if (expectsData && allExpenses.length === 0) return; // wait for the data to land
    pendingRestoreRef.current = null;
    if (!reviewFilterActive) {
      // NORMAL mode: clamp the saved client page to the freshly-loaded slice.
      const totalPages = Math.max(1, Math.ceil(expenses.length / REVIEW_PAGE_SIZE));
      setCurrentPage(clampRestoredPage(snap.pagination.page, totalPages));
    }
    // SERVER-QUERY mode: the server fetch already positioned the exact page (§55).
    workspaceScrollRef.current = { y: snap.scroll.y, anchorExpenseId: snap.scroll.anchorExpenseId };
    setShouldRestoreScroll(true);
  }, [loading, allExpenses, expenses.length, reviewFilterActive]);

  useEffect(() => {
    sessionStorage.setItem("engineerReview:currentPage", String(currentPage));
  }, [currentPage]);

  useEffect(() => {
    if (!shouldRestoreScroll) return;
    setShouldRestoreScroll(false);
    // Prefer a workspace anchor row (§20); fall back to saved scrollY.
    const ws = workspaceScrollRef.current;
    workspaceScrollRef.current = null;
    setTimeout(() => {
      if (ws?.anchorExpenseId) {
        const el = document.querySelector(`[data-expense-id="${ws.anchorExpenseId}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          return;
        }
      }
      const savedY = ws
        ? ws.y
        : parseInt(sessionStorage.getItem("engineerReview:scrollY") ?? "0", 10) || 0;
      if (savedY > 0) window.scrollTo({ top: savedY, behavior: "instant" });
    }, 80);
  }, [shouldRestoreScroll]);

  const fetchEngineerApprovalLimit = async () => {
    if (!organizationId) return;
    try {
      const settings = await getOrgSettings(organizationId);
      const raw = settings?.engineer_approval_limit;
      if (raw !== null && raw !== undefined) {
        const limitValue = Number(raw);
        if (isNaN(limitValue)) {
          setEngineerApprovalLimit(50000);
        } else if (limitValue <= 0) {
          setEngineerApprovalLimit(Number.POSITIVE_INFINITY);
        } else {
          setEngineerApprovalLimit(limitValue);
        }
      } else {
        setEngineerApprovalLimit(Number.POSITIVE_INFINITY);
      }
      setApprovalLimitLoaded(true);
    } catch {
      setEngineerApprovalLimit(50000);
      // Deliberately leave approvalLimitLoaded false on error: without the real
      // limit we must not offer an override approval that could be over-limit.
    }
  };

  // Resolve the real approval limit up front so bulk approve can classify
  // correctly without first opening an expense (§8).
  useEffect(() => {
    if (organizationId) void fetchEngineerApprovalLimit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId]);

  const fetchAssignedExpenses = async (options?: { background?: boolean; loadAll?: boolean }) => {
    const fetchSeq = ++fetchSeqRef.current;
    const isStale = () => fetchSeq !== fetchSeqRef.current;
    // Own the single core controller so a later filtered search (or another
    // normal fetch) truly cancels this one, not just discards its result (§21).
    coreRequestAbortRef.current?.abort();
    const coreController = new AbortController();
    coreRequestAbortRef.current = coreController;

    // A fresh core fetch invalidates enrichment markers so the visible page is
    // re-enriched (and any previously failed lookup gets another chance).
    if (!options?.background) {
      enrichedIdsRef.current = new Set();
      setEnrichmentDegraded(false);
      // Let previously-failed identities retry; resolved identities persist.
      identityStoreRef.current.clearFailures();
      setIdentityDegraded(false);
    }

    // `loadAllRequested` continues paging during this session, but — unlike the
    // old `allExpensesLoaded` — it never asserts that the rows are already here.
    const fetchingAll = options?.loadAll || loadAllRequested;
    const fetchLimit = fetchingAll ? undefined : REVIEW_INITIAL_FETCH_LIMIT;

    try {
      if (!organizationId || !user?.id) return;

      const cacheKey = buildReviewListCacheKey({
        userId: user.id,
        organizationId,
        userRole,
        timePeriod,
        isHierarchyReviewer,
        hierarchyEnabled,
        includeTeamLeaderReports,
        includeExecutiveReports,
      });
      const cached = reviewListCache.get(cacheKey);
      // Only use cache for non-loadAll calls (loadAll must re-fetch to get more rows)
      const showFullScreenLoading = !options?.background && !cached && allExpenses.length === 0;

      if (cached && !options?.background && !options?.loadAll) {
        setAllExpenses(cached.expenses);
        // A truncated cache can never be complete, regardless of what it stored.
        setAllExpensesLoaded(cached.complete && !cached.truncated);
        setTotalAvailable(cached.totalAvailable);
        setNextCursor(cached.nextCursor);
        applyFilters(cached.expenses);
        setLoading(false);
      } else if (showFullScreenLoading) {
        // Stale-while-revalidate: paint localStorage data instantly, then refresh in background.
        // If the cache is valid → setLoading(false) immediately, use backgroundRefreshing instead.
        try {
          const lsKey = buildReviewStorageKey(user.id, organizationId);
          const raw = localStorage.getItem(lsKey);
          const lsEntry = raw ? (JSON.parse(raw) as Partial<ReviewListCacheEntry>) : null;
          const usable =
            lsEntry &&
            Array.isArray(lsEntry.expenses) &&
            lsEntry.expenses.length > 0 &&
            // Reject cache written for a different user, org or scope shape.
            lsEntry.userId === user.id &&
            lsEntry.organizationId === organizationId &&
            lsEntry.scopeVersion === REVIEW_SCOPE_VERSION &&
            typeof lsEntry.cachedAt === "number" &&
            Date.now() - lsEntry.cachedAt < 24 * 60 * 60 * 1000;

          if (usable && lsEntry) {
            setAllExpenses(lsEntry.expenses as Expense[]);
            // Truncated caches resume loading; they may never claim completeness.
            setAllExpensesLoaded(Boolean(lsEntry.complete) && !lsEntry.truncated);
            setTotalAvailable(lsEntry.totalAvailable ?? null);
            setNextCursor(lsEntry.nextCursor ?? null);
            applyFilters(lsEntry.expenses as Expense[]);
            // Cache painted — don't hide it; use background indicator instead
            setLoading(false);
            setBackgroundRefreshing(true);
          } else {
            setLoading(true);
            setBackgroundRefreshing(false);
          }
        } catch {
          setLoading(true);
          setBackgroundRefreshing(false);
        }
      }

      let dateFilter: Date | null = null;
      if (timePeriod === "week") {
        dateFilter = subDays(new Date(), 7);
      } else if (timePeriod === "month") {
        dateFilter = subMonths(new Date(), 1);
      } else if (timePeriod === "year") {
        dateFilter = subYears(new Date(), 1);
      }

      /* ------------------------------------------------------------------ *
       * Canonical path: keyset-paginated RPC, painted page by page.
       *
       * Core rows reach React state as soon as each page lands. Optional
       * enrichment (names, balances, badges, custom fields) runs afterwards in
       * a separate effect scoped to the visible page — it can no longer gate
       * the table.
       * ------------------------------------------------------------------ */
      // Probe the canonical RPC at most once per session: a 404 here is a
      // deployment fact, not a transient failure, and re-probing it on every
      // Load All page would add a pointless 404 per page.
      const known = readCanonicalCapability();
      const countResult =
        known === false
          ? { total: null, missingFunction: true, error: "cached: canonical RPCs absent" }
          : await fetchReviewerVisibleCount(supabase, organizationId, coreController.signal);

      if (known !== false) {
        writeCanonicalCapability(!countResult.missingFunction);
      }
      if (isStale() || coreController.signal.aborted) return;
      setPaginationMode(countResult.missingFunction ? "legacy" : "canonical");

      if (!countResult.missingFunction) {
        setTotalAvailable(countResult.total);
      }

      if (!countResult.missingFunction) {
        const seenIds = new Set<string>();
        const painted: Expense[] = [];

        const paged = await loadReviewerExpensePages(supabase, {
          organizationId,
          startCursor: null,
          seenIds,
          total: countResult.total,
          pageSize: REVIEW_SERVER_PAGE_SIZE,
          pageLimit: fetchingAll ? undefined : REVIEW_INITIAL_PAGE_COUNT,
          signal: coreController.signal,
          onPage: async (freshRows) => {
            if (isStale() || coreController.signal.aborted) return;
            // Hydrate employee identity BEFORE the first visible commit, so a
            // row with a valid user_id never flashes "—". Optional badges still
            // resolve afterwards.
            const rows = await hydrateRowsIdentity(freshRows.map(toCoreExpense));
            if (isStale()) return;
            painted.push(...rows);
            const snapshot = [...painted];
            setAllExpenses(snapshot);
            applyFilters(snapshot);
            setLoading(false);
            setBackgroundRefreshing(false);
          },
        });

        if (isStale()) return;

        if (paged.error && painted.length === 0) {
          // Nothing painted and the first page failed — surface it.
          throw new Error(paged.error);
        }

        setUsedLegacyFallback(false);
        setLoadError(paged.error);
        setNextCursor(paged.nextCursor);

        const complete = isTrulyComplete(
          paged.complete,
          seenIds.size,
          countResult.total,
        );
        setAllExpensesLoaded(complete);

        const cacheEntry: ReviewListCacheEntry = {
          expenses: painted,
          complete,
          totalAvailable: countResult.total,
          cachedAt: Date.now(),
          truncated: !complete,
          nextCursor: paged.nextCursor,
          organizationId,
          userId: user.id,
          scopeVersion: REVIEW_SCOPE_VERSION,
        };
        reviewListCache.set(cacheKey, cacheEntry);
        persistReviewCache(cacheEntry);

        setLoading(false);
        return;
      }

      // Canonical RPC is genuinely absent on this database (verified
      // missing-function / schema-cache error only). Fall back to the legacy
      // paths, which are themselves paged with explicit ranges.
      setUsedLegacyFallback(true);
      if (import.meta.env.DEV) {
        console.warn(
          "[review] canonical reviewer pagination RPC missing — using legacy paged fetch:",
          countResult.error,
        );
      }

      /* ------------------------------------------------------------------ *
       * Legacy initial load — paged, and RESUMABLE.
       *
       * The legacy RPCs have no keyset cursor, so continuation is by explicit
       * row offset. Those offsets are stored in `legacyCursors` so that
       * "Load All" continues from row 300 instead of finding a null keyset
       * cursor and giving up.
       *
       * Page size 250, initial target 300 rows: page 1 requests rows 0-249,
       * page 2 requests only the remaining 50 (range 250-299). Chosen over
       * "round up to 500" so the first paint stays as fast as it is today.
       * ------------------------------------------------------------------ */
      const legacySources = isHierarchyReviewer
        ? HIERARCHY_LEGACY_SOURCES
        : MANAGER_LEGACY_SOURCES;

      if (isHierarchyReviewer || userRole === "engineer") {
        const startCursors = initLegacyCursors(legacySources);
        const seenLegacy = new Set<string>();
        const paintedLegacy: Expense[] = [];

        const legacy = await loadLegacyReviewPages(supabase, {
          organizationId,
          cursors: startCursors,
          seenIds: seenLegacy,
          maxRows: fetchingAll ? undefined : LEGACY_INITIAL_ROWS,
          onPage: async (freshRows) => {
            if (isStale()) return;
            const rows = await hydrateRowsIdentity(freshRows.map(toCoreExpense));
            if (isStale()) return;
            paintedLegacy.push(...rows);
            const snapshot = [...paintedLegacy];
            setAllExpenses(snapshot);
            applyFilters(snapshot);
            setLoading(false);
            setBackgroundRefreshing(false);
          },
        });

        if (isStale()) return;

        if (legacy.error && paintedLegacy.length === 0) {
          throw new Error(legacy.error);
        }

        setLegacyCursors(legacy.cursors);
        setLoadError(legacy.error);
        setNextCursor(null); // not applicable in legacy mode
        // Legacy has no count RPC, so the true total stays unknown.
        setTotalAvailable(null);
        setLoadedCount(paintedLegacy.length);
        setAllExpensesLoaded(legacy.complete);

        const legacyEntry: ReviewListCacheEntry = {
          expenses: paintedLegacy,
          complete: legacy.complete,
          totalAvailable: null,
          cachedAt: Date.now(),
          truncated: !legacy.complete,
          nextCursor: null,
          organizationId,
          userId: user.id,
          scopeVersion: REVIEW_SCOPE_VERSION,
        };
        reviewListCache.set(cacheKey, legacyEntry);
        persistReviewCache(legacyEntry);

        if (userRole === "engineer") {
          setManagerFetchWarning(null);
        }
        setLoading(false);
        return;
      }

      let expenseRows: HierarchyReviewerExpenseRow[];

      if (isHierarchyReviewer) {
        expenseRows = await fetchHierarchyReviewerExpenses(supabase, {
          organizationId,
          userId: user.id,
          dateFilter,
          fetchLimit,
        });
      } else if (userRole === "engineer") {
        setManagerFetchWarning(null);
        expenseRows = (await fetchManagerReviewerExpenses(supabase, {
          organizationId,
          managerUserId: user.id,
          dateFilter,
          hierarchyEnabled,
          teamsEnabled,
          teamLeaderTierEnabled,
          executiveTierEnabled,
          includeTeamLeaderReports,
          includeExecutiveReports,
          fetchLimit,
        })) as HierarchyReviewerExpenseRow[];

        const { error: pendingProbe } = await supabase.rpc("list_manager_pending_expenses", {
          p_organization_id: organizationId,
        });
        if (
          pendingProbe &&
          /function|schema cache|does not exist/i.test(pendingProbe.message)
        ) {
          setManagerFetchWarning(
            "Database migrations are missing on Supabase. Run migrations 20260524310000 through 20260524330000 in SQL Editor, then reload the API schema.",
          );
        }
      } else {
        setAllExpenses([]);
        setExpenses([]);
        return;
      }

      // complete = true ONLY when the server returned fewer rows than the limit we sent,
      // proving no more rows exist.  We must NOT infer complete from `fetchingAll` alone:
      // the RPC may have a server-side cap (e.g. 500) and return exactly that many rows
      // even when we sent an unlimited request.
      const fetchedAll = !fetchLimit
        ? expenseRows.length < REVIEW_INITIAL_FETCH_LIMIT  // unlimited req: complete if < initial cap
        : expenseRows.length < fetchLimit;                  // limited req: complete if < limit

      if (isStale()) return;

      if (!expenseRows || expenseRows.length === 0) {
        const emptyEntry: ReviewListCacheEntry = {
          expenses: [],
          complete: true,
          totalAvailable: 0,
          cachedAt: Date.now(),
          truncated: false,
          nextCursor: null,
          organizationId,
          userId: user.id,
          scopeVersion: REVIEW_SCOPE_VERSION,
        };
        reviewListCache.set(cacheKey, emptyEntry);
        setAllExpenses([]);
        setAllExpensesLoaded(true);
        setTotalAvailable(0);
        setExpenses([]);
        return;
      }

      // Identity is hydrated BEFORE this first visible commit (no "—" flash);
      // optional badges/custom fields still resolve in the visible-page effect.
      const coreRows = await hydrateRowsIdentity(expenseRows.map(toCoreExpense));
      if (isStale()) return;

      setAllExpenses(coreRows);
      setAllExpensesLoaded(fetchedAll);
      setTotalAvailable(null);
      setNextCursor(null);
      applyFilters(coreRows);
      setLoading(false);
      setBackgroundRefreshing(false);

      const cacheEntry: ReviewListCacheEntry = {
        expenses: coreRows,
        complete: fetchedAll,
        totalAvailable: null,
        cachedAt: Date.now(),
        truncated: !fetchedAll,
        nextCursor: null,
        organizationId,
        userId: user.id,
        scopeVersion: REVIEW_SCOPE_VERSION,
      };
      reviewListCache.set(cacheKey, cacheEntry);
      persistReviewCache(cacheEntry);
    } catch (error) {
      console.error("Error fetching assigned expenses:", error);
      toast({
        variant: "destructive",
        title: "Could not load expenses",
        description:
          error instanceof Error ? error.message : "Failed to load assigned expenses.",
      });
    } finally {
      if (!isStale() && !options?.background) {
        setLoading(false);
        setBackgroundRefreshing(false);
      }
    }
  };

  fetchAssignedExpensesRef.current = fetchAssignedExpenses;

  /**
   * FILTERED mode (DOC-080 §2-§9): when an employee is selected or a general
   * search is submitted, fetch ONLY the matching rows from the server RPC instead
   * of loading the whole reviewer scope. Employee 6174 → ~30 rows, never ~9,244.
   * The returned rows already carry employee identity (no "—" flash) and flow
   * through the existing render / selection / approval pipeline unchanged; the
   * server's actionability fields are ignored — this is search transport only.
   */
  /** Map the APPLIED query to the server queue-RPC parameters (§16-§19). */
  const buildServerQueryParams = (): ServerQueryParams => {
    const applied = appliedQueryRef.current;
    const { from, to } = deriveDateRange(applied.timePeriod, new Date());
    return {
      organizationId: organizationId as string,
      employeeUserId: applied.employeeUserId,
      generalSearch: applied.generalSearch,
      statuses: statusToServerStatuses(applied.status),
      dateFrom: from,
      dateTo: to,
      sort: appliedSortToServerSort(applied.sortBy, applied.sortOrder),
      customFilters: customFilterRecordToServer(
        applied.customFilters,
        customFieldResolverRef.current,
      ),
    };
  };

  /**
   * Fetch EXACTLY ONE server page (§22-§27). Next/Previous reuse the cursor
   * history so no intervening page is re-downloaded; a page whose cursor is
   * unknown (a direct jump) resolves it via the page-anchor RPC. Never
   * pre-downloads a bounded window and slices — a "Level 2 Verified" result of
   * 1,663 rows shows page 1 with one 25-row request.
   */
  const fetchServerPageInternal = async (
    targetPage: number,
    options?: { background?: boolean },
  ) => {
    if (!organizationId || !user?.id) return;
    if (!isServerQueryActive(appliedQueryRef.current)) return;
    const page = Math.max(1, Math.floor(targetPage));

    // Single-flight (§12/§30): a BACKGROUND refresh for the query+page already
    // loading must not abort-and-restart it (the aborted-mid-body window).
    const queryKey = `${currentReviewQueryKey()}#p${page}`;
    if (
      options?.background &&
      activeCoreQueryKeyRef.current === queryKey &&
      coreRequestAbortRef.current &&
      !coreRequestAbortRef.current.signal.aborted
    ) {
      return;
    }

    const fetchSeq = ++fetchSeqRef.current;
    const isStale = () => fetchSeq !== fetchSeqRef.current;
    activeCoreQueryKeyRef.current = queryKey;
    coreRequestAbortRef.current?.abort();
    const controller = new AbortController();
    coreRequestAbortRef.current = controller;
    if (!options?.background && allExpenses.length === 0) setLoading(true);
    else setBackgroundRefreshing(true);
    if (!options?.background) {
      setFilteredResultCount(null);
      setServerQueryError(null);
    }

    const params = buildServerQueryParams();
    const history = serverCursorHistoryRef.current;

    // Bound the request so a hung Production query cannot leave the UI on
    // "counting…" indefinitely — a timeout aborts and is surfaced as an error (§28).
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, SERVER_QUERY_TIMEOUT_MS);

    try {
      let result: ServerQueryPage;
      let usedCursor: ReviewQueueCursor | null;
      if (page === 1 || history.has(page)) {
        usedCursor = page === 1 ? null : history.get(page) ?? null;
        result = await fetchServerQueryPage(params, {
          cursor: usedCursor,
          pageSize: SERVER_QUERY_PAGE_SIZE,
          signal: controller.signal,
        });
      } else {
        // Cursor unknown → one anchor call + one page call (§26), never a walk.
        const jump = await fetchServerQueryPageByNumber(params, {
          targetPage: page,
          pageSize: SERVER_QUERY_PAGE_SIZE,
          signal: controller.signal,
        });
        result = jump.page;
        usedCursor = jump.cursor;
      }
      clearTimeout(timeoutId);
      if (isStale() || controller.signal.aborted) return;

      recordCursor(history, page, usedCursor);
      if (result.nextCursor) recordCursor(history, page + 1, result.nextCursor);
      serverNextCursorRef.current = result.nextCursor;

      setPaginationMode("canonical");
      setUsedLegacyFallback(false);
      setLoadError(null);
      setServerQueryError(null);
      setNextCursor(null);
      setManagerFetchWarning(null);
      setAllExpenses(result.rows);
      // This page is exactly what we show — never a partial "Load All" state.
      setAllExpensesLoaded(true);
      setTotalAvailable(result.filteredTotal);
      setFilteredResultCount(result.filteredTotal);
      setServerTotalPages(
        result.totalPages > 0
          ? result.totalPages
          : totalPagesFor(result.filteredTotal, SERVER_QUERY_PAGE_SIZE),
      );
      setServerFilteredSummary(result.filteredSummary ?? null);
      setServerPage(page);
      serverPageRef.current = page;
      setCurrentPage(page);
      applyFilters(result.rows);
      setLoading(false);
      setBackgroundRefreshing(false);
    } catch (e) {
      clearTimeout(timeoutId);
      const aborted =
        controller.signal.aborted ||
        (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message)));
      // A newer query superseded this one, or an unmount/navigation aborted it —
      // stay silent. But a TIMEOUT is a real failure the user must see, even
      // though it also aborts the controller (§28).
      if (isStale() || (aborted && !timedOut)) return;
      // A 504 / network failure / timeout keeps the prior page on screen and
      // surfaces a controlled, retryable error — no retry loop, no fallback to
      // normal mode, no storm (§27/§54). The chip leaves "counting…".
      const message = timedOut
        ? "The filtered results took too long to load. Please retry."
        : e instanceof Error
          ? e.message
          : String(e);
      setLoadError(message);
      setServerQueryError(message);
      setLoading(false);
      setBackgroundRefreshing(false);
    }
  };

  /** Refresh the CURRENT server page in place (realtime / mutation / retry). */
  const fetchFilteredExpenses = (options?: { background?: boolean }) =>
    fetchServerPageInternal(serverPageRef.current, options);

  /**
   * Navigate to a specific 1-based server page (Next / Previous / direct jump).
   * A fresh applied query resets the history and lands on page 1 (§29 D / §53).
   */
  const goServerPage = (targetPage: number) => {
    void fetchServerPageInternal(targetPage);
  };

  fetchFilteredExpensesRef.current = fetchFilteredExpenses;

  /* ── Search submit coordinator (§8/§29) ─────────────────────────────────── */

  /**
   * Copy EVERY staged draft control to the applied query in ONE batch and bump
   * the revision, so the effects see a single atomic transition and run exactly
   * one query (§8). Resets pagination to page 1 and clears the financial
   * selection (§29 D/E).
   */
  const commitDraftFilters = () => {
    setStatusFilter(draftStatus);
    setSortBy(draftSortBy);
    setSortOrder(draftSortOrder);
    setTimePeriod(draftTimePeriod);
    setShowOnlyActionable(draftShowOnlyActionable);
    setIncludeTeamLeaderReports(draftIncludeTeamLeaderReports);
    setIncludeExecutiveReports(draftIncludeExecutiveReports);
    setCustomFieldFilters(draftCustomFieldFilters);
    serverPageRef.current = 1;
    setServerPage(1);
    setCurrentPage(1);
    setSelectedKeys(new Set());
    setAppliedRevision((r) => r + 1);
  };
  commitDraftFiltersRef.current = commitDraftFilters;

  /**
   * THE single submit path (Search button / Enter). Commits all staged filters
   * together (§8). An already-resolved, UNCHANGED search does NOT re-hit the
   * employee RPC — filters commit directly (§9/§47); only genuinely new/changed
   * search text is resolved, and its resolution commits the staged filters
   * atomically (see handleSearchResolved, §10/§29 C2).
   */
  const handleSubmitReviewQuery = () => {
    const draftText = singleBar.draft.trim();
    const appliedText = (singleBar.submitted ?? "").trim();
    const hasResolvedSearch = Boolean(singleBar.selectedEmployee || singleBar.generalSearch);
    if (draftText !== "" && draftText === appliedText && hasResolvedSearch) {
      commitDraftFilters(); // C1: identical search — zero employee lookups.
      return;
    }
    // C2: resolve (or clear, for empty text) first; the resolution commits.
    pendingSubmitCommitRef.current = true;
    void singleBar.submit();
  };

  /**
   * THE single authority for refreshing Review data (§3/§4). It inspects the
   * CURRENT committed mode and routes to the matching fetch — filtered queries
   * refresh the filtered page, normal queries refresh the normal scope. Every
   * refresh trigger (realtime, mutations, retry) goes through here so a filtered
   * user is never sent back through the full normal reviewer fetch.
   */
  const refreshCurrentReviewQuery = (options?: { background?: boolean }): Promise<void> => {
    if (reviewFilterActiveRef.current) {
      return fetchFilteredExpensesRef.current(options);
    }
    return fetchAssignedExpensesRef.current(options);
  };
  refreshCurrentReviewQueryRef.current = refreshCurrentReviewQuery;

  /* ---------------------------------------------------------------------- *
   * Identity resolution (CORE row data — name / employee ID / balance)
   *
   * Kept deliberately separate from the optional-badge effect below. Identity is
   * resolved by user_id through a dedicated store that caches a profile the
   * moment it arrives and NEVER discards it because a later render happened —
   * the previous seq-cancellation model threw away successfully-fetched profiles
   * and left rows permanently on "—". A resolved profile then patches EVERY row
   * sharing that user_id, so all lines of a batch (and rows on other pages)
   * populate together. A failed fetch is retryable, not a permanent placeholder.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!organizationId || !user?.id) return;
    if (allExpenses.length === 0) return;
    // FILTERED rows come from the queue RPC with employee identity already on the
    // row — no profile lookup needed. Skipping avoids a redundant request storm
    // during search (§14/§15/§43).
    if (reviewFilterActive) return;

    const totalPagesForId = Math.max(1, Math.ceil(expenses.length / REVIEW_PAGE_SIZE));
    const page = Math.min(currentPage, totalPagesForId);
    const start = (page - 1) * REVIEW_PAGE_SIZE;
    // Current page plus one page of lookahead, and the open expense.
    const visible = expenses.slice(start, start + REVIEW_PAGE_SIZE * 2);
    const userIds = new Set<string>();
    for (const e of visible) if (e.user_id) userIds.add(e.user_id);
    if (selectedExpense?.id) {
      const row = allExpenses.find((e) => e.id === selectedExpense.id);
      if (row?.user_id) userIds.add(row.user_id);
    }

    const need = identityStoreRef.current.pending(userIds);
    if (need.length === 0) return;

    void (async () => {
      const { newlyResolved, failed } = await identityStoreRef.current.resolve(need, (ids) =>
        fetchExpenseSubmitterProfiles(supabase, organizationId, ids),
      );
      if (!mountedRef.current) return;
      // A profile fetched here is cached regardless of what re-rendered while it
      // was in flight; bump a version so the patch effect re-applies identities.
      if (newlyResolved.length > 0) setIdentityVersion((v) => v + 1);
      if (failed.length > 0) setIdentityDegraded(true);
      else if (newlyResolved.length > 0) setIdentityDegraded(false);
    })();
  }, [expenses, currentPage, allExpenses, organizationId, user?.id, selectedExpense?.id, reviewFilterActive]);

  /**
   * Re-apply resolved identities to every held row whenever identities change.
   * Idempotent (applyReviewRowIdentity returns the same object when nothing
   * changed), so this converges and never reorders or re-pages.
   */
  useEffect(() => {
    if (identityVersion === 0) return;
    const applyId = (row: Expense): Expense =>
      applyReviewRowIdentity(row, identityStoreRef.current, resolveSubmitterEmployeeId);
    setAllExpenses((prev) => prev.map(applyId));
    setExpenses((prev) => prev.map(applyId));
  }, [identityVersion]);

  /* ---------------------------------------------------------------------- *
   * Optional badges (resubmitted / reviewer-corrected / custom fields)
   *
   * Truly optional: a failure here shows a degraded hint but never blanks a
   * name (identity is resolved above, independently). Keyed by expense id; a
   * superseded run may be discarded because badges, unlike identity, are not
   * globally reusable and cheap to recompute on the next page.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    if (!organizationId || !user?.id) return;
    if (allExpenses.length === 0) return;
    // FILTERED rows already carry custom_fields, is_resubmitted and
    // was_reviewer_corrected from the queue RPC — do NOT re-fetch them per row.
    // This is the dominant request storm the incident HAR showed (§14/§33/§43).
    if (reviewFilterActive) return;

    const totalPagesForEnrich = Math.max(1, Math.ceil(expenses.length / REVIEW_PAGE_SIZE));
    const page = Math.min(currentPage, totalPagesForEnrich);
    const start = (page - 1) * REVIEW_PAGE_SIZE;
    const visible = expenses.slice(start, start + REVIEW_PAGE_SIZE * 2);

    const targets = visible.filter((e) => e?.id && !enrichedIdsRef.current.has(e.id));
    if (
      selectedExpense?.id &&
      !enrichedIdsRef.current.has(selectedExpense.id) &&
      !targets.some((t) => t.id === selectedExpense.id)
    ) {
      const row = allExpenses.find((e) => e.id === selectedExpense.id);
      if (row) targets.push(row);
    }
    if (targets.length === 0) return;

    const seq = ++enrichSeqRef.current;
    const ids = targets.map((e) => e.id);
    ids.forEach((id) => enrichedIdsRef.current.add(id));

    void (async () => {
      const [resubmittedRes, correctedRes, customRes] = await Promise.allSettled([
        fetchResubmittedExpenseIds(supabase, ids, organizationId),
        ExpenseService.getExpenseIdsWithReviewerCorrections(ids, organizationId),
        fetchExpenseCustomFieldsMap(organizationId, ids),
      ]);

      if (seq !== enrichSeqRef.current) return;

      const resubmitted =
        resubmittedRes.status === "fulfilled" ? resubmittedRes.value : new Set<string>();
      const corrected =
        correctedRes.status === "fulfilled" ? correctedRes.value : new Set<string>();
      const customByExpense =
        customRes.status === "fulfilled"
          ? customRes.value
          : ({} as Record<string, Record<string, string>>);

      const anyOptionalFailed =
        resubmittedRes.status === "rejected" ||
        correctedRes.status === "rejected" ||
        customRes.status === "rejected";
      setEnrichmentDegraded(anyOptionalFailed);

      const idSet = new Set(ids);
      const patch = (row: Expense): Expense => {
        if (!idSet.has(row.id)) return row;
        return {
          ...row,
          isResubmitted: resubmitted.has(row.id) || row.isResubmitted,
          wasReviewerCorrected: corrected.has(row.id) || row.wasReviewerCorrected,
          custom_fields: customByExpense[row.id] ?? row.custom_fields,
        };
      };

      setAllExpenses((prev) => prev.map(patch));
      setExpenses((prev) => prev.map(patch));
    })();
  }, [
    expenses,
    currentPage,
    allExpenses,
    organizationId,
    user?.id,
    selectedExpense?.id,
    reviewFilterActive,
  ]);

  /**
   * Continue a LEGACY load from each source's stored row offset.
   *
   * Resumes at row 300 (or wherever the last page stopped) — it never restarts
   * at offset 0, and it never re-runs the initial page's enrichment. Completion
   * requires every legacy source to be exhausted, not just the first.
   */
  const loadLegacyRemainingPages = async (signal: AbortSignal) => {
    if (!organizationId || !user?.id) return;

    const seenIds = new Set(allExpenses.map((e) => e.id));
    const accumulated: Expense[] = [...allExpenses];
    const startCursors =
      legacyCursors.length > 0
        ? legacyCursors
        : initLegacyCursors(
            isHierarchyReviewer ? HIERARCHY_LEGACY_SOURCES : MANAGER_LEGACY_SOURCES,
          );

    const legacy = await loadLegacyReviewPages(supabase, {
      organizationId,
      cursors: startCursors, // ← resume, never offset 0
      seenIds,
      signal,
      onPage: async (freshRows) => {
        const rows = await hydrateRowsIdentity(freshRows.map(toCoreExpense));
        accumulated.push(...rows);
        const snapshot = [...accumulated];
        setAllExpenses(snapshot);
        applyFilters(snapshot);
        setLoadedCount(snapshot.length);
      },
    });

    setLegacyCursors(legacy.cursors);
    setLoadError(legacy.error);
    setLoadedCount(accumulated.length);

    // Complete only when EVERY legacy source returned a short page.
    const complete = legacy.complete && legacyCursorsComplete(legacy.cursors);
    setAllExpensesLoaded(complete);
    if (complete) {
      sessionStorage.setItem("pesowise:load-all:review", "true");
    }

    const cacheKey = buildReviewListCacheKey({
      userId: user.id,
      organizationId,
      userRole,
      timePeriod,
      isHierarchyReviewer,
      hierarchyEnabled,
      includeTeamLeaderReports,
      includeExecutiveReports,
    });
    const entry: ReviewListCacheEntry = {
      expenses: accumulated,
      complete,
      totalAvailable: null,
      cachedAt: Date.now(),
      truncated: !complete,
      nextCursor: null,
      organizationId,
      userId: user.id,
      scopeVersion: REVIEW_SCOPE_VERSION,
    };
    reviewListCache.set(cacheKey, entry);
    persistReviewCache(entry);
  };

  /**
   * Continue loading from the last keyset cursor.
   *
   * This does NOT re-run the initial fetch. Restarting at page 1 was why the old
   * "Load All" kept re-reading the same capped 1,000-row window forever.
   */
  const handleLoadAllExpenses = async () => {
    if (!organizationId || !user?.id) return;
    // Load All is a NORMAL-mode operation over the full reviewer scope. In
    // filtered mode the filtered set is already fully loaded, so this must never
    // run — it would read thousands of rows behind the search (§8).
    if (reviewFilterActiveRef.current) return;
    // Guard re-entry; without this a double click starts two paging runs that
    // both append to the same list.
    if (loadingAllExpenses || allExpensesLoaded) return;

    setLoadAllRequested(true);
    setLoadingAllExpenses(true);
    setLoadError(null);

    const controller = new AbortController();
    loadAllAbortRef.current?.abort();
    loadAllAbortRef.current = controller;

    try {
      /* ------------------------------------------------------------------ *
       * Branch on the EXPLICIT pagination mode.
       *
       * The previous version keyed entirely off `nextCursor`. In legacy mode
       * that cursor is always null, so this handler returned immediately AND
       * set allExpensesLoaded(true) — a silent no-op that also lied about
       * completeness. Legacy continuation uses per-source offsets instead.
       * ------------------------------------------------------------------ */
      if (paginationMode === "legacy") {
        await loadLegacyRemainingPages(controller.signal);
        return;
      }

      // Mode not detected yet (e.g. Load All clicked before the first fetch
      // settled) — run the normal fetch, which performs detection.
      if (paginationMode === null) {
        await fetchAssignedExpenses({ loadAll: true });
        return;
      }

      // Canonical mode below.
      if (!nextCursor && allExpenses.length === 0) {
        await fetchAssignedExpenses({ loadAll: true });
        return;
      }
      if (!nextCursor) {
        // Canonical cursor exhausted — genuinely complete.
        setAllExpensesLoaded(true);
        return;
      }

      const seenIds = new Set(allExpenses.map((e) => e.id));
      const accumulated: Expense[] = [...allExpenses];
      let total = totalAvailable;

      if (total === null) {
        const countResult = await fetchReviewerVisibleCount(supabase, organizationId);
        if (!countResult.missingFunction) {
          total = countResult.total;
          setTotalAvailable(total);
        }
      }

      const paged = await loadReviewerExpensePages(supabase, {
        organizationId,
        startCursor: nextCursor, // ← resume, never restart
        seenIds,
        total,
        pageSize: REVIEW_SERVER_PAGE_SIZE,
        signal: controller.signal,
        onPage: async (freshRows) => {
          const rows = await hydrateRowsIdentity(freshRows.map(toCoreExpense));
          accumulated.push(...rows);
          const snapshot = [...accumulated];
          setAllExpenses(snapshot);
          applyFilters(snapshot);
          setLoadedCount(snapshot.length);
        },
      });

      setNextCursor(paged.nextCursor);
      setLoadError(paged.error);

      const complete = isTrulyComplete(paged.complete, seenIds.size, total);
      setAllExpensesLoaded(complete);

      // The session preference only records genuine completion.
      if (complete) {
        sessionStorage.setItem("pesowise:load-all:review", "true");
      }

      if (paged.stalled && import.meta.env.DEV) {
        console.warn("[review] pagination cursor stalled; stopped to avoid a loop");
      }

      const cacheKey = buildReviewListCacheKey({
        userId: user.id,
        organizationId,
        userRole,
        timePeriod,
        isHierarchyReviewer,
        hierarchyEnabled,
        includeTeamLeaderReports,
        includeExecutiveReports,
      });
      const entry: ReviewListCacheEntry = {
        expenses: accumulated,
        complete,
        totalAvailable: total,
        cachedAt: Date.now(),
        truncated: !complete,
        nextCursor: paged.nextCursor,
        organizationId,
        userId: user.id,
        scopeVersion: REVIEW_SCOPE_VERSION,
      };
      reviewListCache.set(cacheKey, entry);
      persistReviewCache(entry);
    } catch (error) {
      // Rows already loaded stay on screen; only the error banner changes.
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingAllExpenses(false);
    }
  };

  /** Query-aware retry (§27): retry the filtered query in filtered mode, else resume the normal load. */
  const handleRetryRemaining = () => {
    setLoadError(null);
    if (reviewFilterActiveRef.current) {
      void fetchFilteredExpensesRef.current();
    } else {
      void handleLoadAllExpenses();
    }
  };

  useEffect(() => {
    const wasLoadingAll = prevLoadingAllRef.current;
    prevLoadingAllRef.current = loadingAllExpenses;

    if (loadingAllExpenses && !wasLoadingAll) {
      startLoadAll(t("review.progress.loadAll"), { description: t("review.progress.loadAllHint") });
    } else if (!loadingAllExpenses && wasLoadingAll) {
      // Real numbers: loaded is what we hold, total is what the server reported.
      // Reporting `total: allExpenses.length` made every partial load look complete.
      // With no server count (legacy mode) we must not invent a total — report
      // "N+ loaded" instead of a fabricated "N of N".
      completeLoadAll(
        totalAvailable !== null
          ? t("review.progress.loadedCount", {
              loaded: allExpenses.length,
              total: totalAvailable,
            })
          : `Loaded ${allExpenses.length}+ expenses`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingAllExpenses]);

  useEffect(
    () => () => {
      loadAllAbortRef.current?.abort();
      coreRequestAbortRef.current?.abort();
    },
    [],
  );

  // Entering filtered search immediately aborts any in-flight normal Load All so
  // it stops reading thousands of rows behind the search (§8). Search owns the
  // data from this point.
  useEffect(() => {
    if (reviewFilterActive) {
      loadAllAbortRef.current?.abort();
      if (loadingAllExpenses) setLoadingAllExpenses(false);
    }
  }, [reviewFilterActive, loadingAllExpenses]);

  const formatEmployeeSubline = (expense: Expense) => {
    const employeeId = (expense.user_employee_id ?? "").trim();
    if (employeeIdLoginEnabled) {
      return employeeId || "—";
    }
    return employeeId || expense.user_email || "—";
  };

  /**
   * Custom-field values are enriched per visible page, so a custom-field filter
   * can only see the rows enriched so far. Rather than silently returning an
   * incomplete result set, the UI states the limit and offers the full load.
   * (Option B of the three documented approaches — see DOC-074.)
   */
  const hasActiveCustomFieldFilter = useMemo(
    () => Object.values(customFieldFilters ?? {}).some((v) => String(v ?? "").trim() !== ""),
    [customFieldFilters],
  );
  const customFieldFilterIncomplete =
    hasActiveCustomFieldFilter &&
    allExpenses.some((e) => e.custom_fields === undefined);

  /**
   * When a custom-field filter is active AND the whole authorized set is loaded,
   * fill in custom fields for every remaining row so the filter result is
   * genuinely complete. Batching/concurrency (25 ids, max 3 in flight) is
   * enforced inside fetchExpenseCustomFieldsMap.
   */
  useEffect(() => {
    if (!organizationId) return;
    if (!hasActiveCustomFieldFilter) return;
    if (!allExpensesLoaded) return; // only safe to claim completeness once fully loaded

    const missing = allExpenses.filter((e) => e.custom_fields === undefined).map((e) => e.id);
    if (missing.length === 0) return;

    let cancelled = false;
    void (async () => {
      try {
        const map = await fetchExpenseCustomFieldsMap(organizationId, missing);
        if (cancelled) return;
        const patch = (row: Expense): Expense =>
          row.custom_fields === undefined && map[row.id] !== undefined
            ? { ...row, custom_fields: map[row.id] }
            : row;
        setAllExpenses((prev) => prev.map(patch));
        setExpenses((prev) => prev.map(patch));
      } catch {
        if (!cancelled) setEnrichmentDegraded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasActiveCustomFieldFilter, allExpensesLoaded, allExpenses, organizationId]);

  const applyFilters = (expensesList: Expense[]) => {
    // SERVER-QUERY mode: the queue RPC already applied employee / general search
    // / status / time / custom filters AND the sort, over the WHOLE population,
    // and handed us exactly this page in server order. Re-filtering or re-sorting
    // client-side would only risk dropping or reordering rows the server already
    // authoritatively selected (§15/§19/§25/§32). The one deliberately client-side
    // refinement is "Needs my verification only" (§41), applied over the loaded
    // page — its resulting count is therefore loaded-page scoped, not the global
    // filtered total.
    if (reviewFilterActive) {
      const rows =
        showOnlyActionable && userRole === "engineer"
          ? expensesList.filter((exp) => isReadyForManagerReview(exp))
          : expensesList;
      setExpenses(rows);
      return;
    }

    let filtered = expensesList;

    // Employee filter (DOC-080): filter by the immutable user_id resolved from
    // the employee search. This is authoritative identity — it does not depend
    // on async name/ID enrichment of the loaded rows, so it never has the false
    // negatives the old free-text name search had, and it composes (AND) with
    // the expense text search below.
    if (selectedEmployeeUserId) {
      filtered = filtered.filter((exp) => exp.user_id === selectedEmployeeUserId);
    }

    // Apply expense text search (transaction #, project, title, destination,
    // amount, custom fields).
    if (searchTerm) {
      filtered = filtered.filter((exp) =>
        expenseRowMatchesSearch(
          {
            ...exp,
            transaction_number: (exp as { transaction_number?: string }).transaction_number,
          },
          searchTerm,
          expenseSearchIdentityOptions,
        ),
      );
    }

    // Apply status filter (manager queue: include stuck rows at engineer tier)
    if (statusFilter === "level_2_verified" && userRole === "engineer") {
      filtered = filtered.filter(
        (exp) =>
          exp.status === "level_2_verified" ||
          (exp.approval_tier === "engineer" &&
            ["submitted", "edited", "level_1_verified"].includes(exp.status)),
      );
    } else if (statusFilter !== "all") {
      filtered = filtered.filter((exp) => exp.status === statusFilter);
    }

    filtered = filtered.filter((exp) =>
      matchesCustomFieldFilters(exp.custom_fields, customFieldFilters),
    );

    if (showOnlyActionable && userRole === "engineer") {
      filtered = filtered.filter((exp) => isReadyForManagerReview(exp));
    }

    filtered = [...filtered].sort((a, b) => {
      let aValue: number | string;
      let bValue: number | string;

      switch (sortBy) {
        case "trip_start":
          aValue = (parseLocalDate(a.trip_start) ?? new Date(a.trip_start)).getTime();
          bValue = (parseLocalDate(b.trip_start) ?? new Date(b.trip_start)).getTime();
          break;
        case "created_at":
        default:
          aValue = new Date(a.created_at).getTime();
          bValue = new Date(b.created_at).getTime();
          break;
      }

      if (sortOrder === "asc") {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0;
      }
      return aValue > bValue ? -1 : aValue < bValue ? 1 : 0;
    });

    setExpenses(filtered);
  };

  const fetchExpenseDetails = async (expenseId: string, expenseRow?: Expense | null) => {
    try {
      // Fetch line items
      const { data: lineItemsData, error: lineItemsError } = await supabase
        .from("expense_line_items")
        .select("*")
        .eq("expense_id", expenseId)
        .order("date");

      if (lineItemsError) throw lineItemsError;

      // Fetch attachments
      const { data: attachmentsData, error: attachmentsError } = await supabase
        .from("attachments")
        .select("*")
        .eq("expense_id", expenseId)
        .order("created_at");

      if (attachmentsError) throw attachmentsError;

      setLineItems(lineItemsData || []);
      setAttachments(
        (attachmentsData || []).map((att) => ({
          ...att,
          file_url: normalizeReceiptPublicUrl(att.file_url || ""),
        })),
      );

      const { data: logsData, error: logsError } = await supabase
        .from("audit_logs")
        .select("user_id, action, comment, created_at")
        .eq("expense_id", expenseId)
        .order("created_at", { ascending: true });

      if (logsError) {
        console.error("Error fetching audit logs:", logsError);
        setAuditLogs([]);
      } else {
        setAuditLogs(await enrichAuditLogsWithDisplay(logsData || []));
      }

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

      if (user?.id) {
        const rows = await ExpenseService.listExpenseCorrectionLogs(expenseId, user.id);
        const editorIds = [...new Set(rows.map((r) => r.edited_by))];
        if (editorIds.length > 0) {
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
        } else {
          setCorrectionLogs(rows);
        }
      } else {
        setCorrectionLogs([]);
      }
    } catch (error) {
      console.error("Error fetching expense details:", error);
    }
  };

  const correctionsFeatureEnabled = Boolean(
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_manager_admin_expense_corrections],
  );

  const canEngineerCorrectExpense = (exp: Expense | null) => {
    if (!exp || !user?.id) return false;
    if (!correctionsFeatureEnabled) return false;
    if (exp.user_id === user.id) return false;
    if (isReadyForManagerReview(exp)) {
      return [
        "submitted",
        "verified",
        "under_review",
        "rejected",
        "edited",
        "level_1_verified",
        "level_2_verified",
      ].includes(exp.status);
    }
    if (
      exp.assigned_reviewer_id === user.id ||
      exp.assigned_engineer_id === user.id
    ) {
      return [
        "submitted",
        "verified",
        "under_review",
        "rejected",
        "edited",
        "level_1_verified",
        "level_2_verified",
      ].includes(exp.status);
    }
    return false;
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
    if (!selectedExpense || !user?.id) return;
    setCorrectionLoading(true);
    try {
      const amt = Number(corrAmount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Amount must be a positive number");

      if (corrFieldModel.loadError) throw new Error(corrFieldModel.loadError);

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
      toast({
        title: "Expense corrected",
        description: "Audit log saved. The expense is marked adjusted for reviewers; the employee still sees it as in review.",
      });
      setCorrectionDialogOpen(false);
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
      await refreshCurrentReviewQuery();
      await fetchExpenseDetails(selectedExpense.id, selectedExpense);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to save correction";
      toast({ variant: "destructive", title: t("admin:review.toast.correctionFailed"), description: msg });
    } finally {
      setCorrectionLoading(false);
    }
  };

  const verifyExpense = async () => {
    if (!selectedExpense || !user) return;

    try {
      setReviewLoading(true);

      const updated = await ExpenseService.verifyExpense(
        selectedExpense.id,
        user.id,
        engineerComment,
        { reviewerRole: userRole },
      );

      const statusKey =
        updated.status === "level_1_verified"
          ? "level1Verified"
          : updated.status === "level_2_verified"
            ? "level2Verified"
            : updated.status === "verified"
              ? "verified"
              : updated.status === "submitted"
                ? "submitted"
                : null;

      const verifiedLabel = statusKey
        ? t(`expenses:status.${statusKey}`)
        : String(updated.status);

      toast({
        title: "Success",
        description: t("admin:review.verifySuccessStatus", {
          status: verifiedLabel,
          defaultValue: `Expense marked as ${verifiedLabel}`,
        }),
      });

      setSelectedExpense(null);
      setEngineerComment("");
      setLineItems([]);
      setAttachments([]);
      setAuditLogs([]);
      refreshCurrentReviewQuery();
    } catch (error: any) {
      console.error("Error verifying expense:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to verify expense",
      });
    } finally {
      setReviewLoading(false);
    }
  };

  const approveExpense = async () => {
    if (!selectedExpense || !user) return;
    const exp = selectedExpense;

    const isReady = isPendingForCurrentReviewer(exp);
    const isTerminal = isTerminalReviewStatus(exp.status);
    const overLimit = Number(exp.total_amount) > Number(engineerApprovalLimit);

    // Waiting (or over-limit / terminal) → confirm first via the shared dialog
    // (§15). Nothing mutates here — the dialog's PROCEED runs the override for a
    // waiting-but-eligible row, or stays disabled for over-limit / no-capability.
    if (!isReady || isTerminal || overLimit) {
      setApprovalWarning({
        classification: classifySelection([exp]),
        selectedTotal: Number(exp.total_amount || 0),
        mode: "single",
        targets: [exp],
      });
      return;
    }

    // Ready now and within limit → normal V2 approval.
    try {
      setReviewLoading(true);
      await ExpenseService.approveExpense(exp.id, user.id, engineerComment);
      toast({
        title: "Expense Approved",
        description: `Expense approved and ${formatINR(exp.total_amount)} deducted from employee balance.`,
      });
      setSelectedExpense(null);
      setEngineerComment("");
      setLineItems([]);
      setAttachments([]);
      setAuditLogs([]);
      refreshCurrentReviewQuery();
    } catch (error: any) {
      console.error("Error approving expense:", error);
      toast({
        variant: "destructive",
        title: "Error",
        description: error.message || "Failed to approve expense",
      });
    } finally {
      setReviewLoading(false);
    }
  };

  const rejectExpense = async () => {
    if (!selectedExpense || !user) return;

    try {
      setReviewLoading(true);

      await ExpenseService.rejectExpense(selectedExpense.id, user.id, engineerComment);

      toast({
        title: "Expense Rejected",
        description: "Expense has been rejected successfully",
      });

      setSelectedExpense(null);
      setEngineerComment("");
      setLineItems([]);
      setAttachments([]);
      setAuditLogs([]);
      refreshCurrentReviewQuery();
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

  const getExpenseQueueHint = (exp: Expense) => {
    if (userRole === "engineer" && exp.status === "level_2_verified") {
      return "Executive step done — ready for your final approval";
    }
    if (userRole === "engineer" && isReadyForManagerReview(exp)) {
      return "Executive step done — ready for your verification";
    }
    if (!exp.approval_tier) return null;
    const tier = exp.approval_tier.replace(/_/g, " ");
    if (userRole === "engineer" && exp.approval_tier !== "engineer") {
      return `With ${getRoleLabel(exp.approval_tier as "team_leader" | "executive" | "engineer", roleLabels) || tier}`;
    }
    return null;
  };

  const isReadyForManagerReview = (exp: Expense) => {
    if (exp.manager_queue_ready) return true;
    if (exp.status === "level_2_verified") return true;
    if (exp.approval_tier === "engineer") {
      return ["submitted", "edited", "level_1_verified", "level_2_verified", "under_review"].includes(
        exp.status,
      );
    }
    if (
      exp.approval_tier &&
      isSkippedHierarchyTier(exp.approval_tier, hierarchyEnabled, {
        teamLeaderTierEnabled,
        executiveTierEnabled,
      })
    ) {
      return ["submitted", "edited", "level_1_verified", "level_2_verified", "under_review"].includes(
        exp.status,
      );
    }
    if (!hierarchyEnabled) {
      return ["submitted", "edited", "under_review"].includes(exp.status);
    }
    return false;
  };

  const isPendingForCurrentReviewer = (exp: Expense) => {
    if (userRole === "engineer") {
      if (isReadyForManagerReview(exp)) return true;
      if (
        (exp.status === "submitted" || exp.status === "edited") &&
        !hierarchyEnabled
      ) {
        return true;
      }
      return false;
    }
    if (userRole === "team_leader") {
      return exp.status === "submitted" || exp.status === "edited";
    }
    if (userRole === "executive") {
      if (exp.status === "submitted" || exp.status === "edited") return true;
      if (exp.status === "level_1_verified") return true;
      return false;
    }
    if (exp.status === "submitted" || exp.status === "edited") return true;
    return false;
  };

  /**
   * Canonical 3-state for a singular row (ready=blue / waiting=amber /
   * completed=grey), shared with the batch button and mobile via
   * reviewStatePresentation. "waiting" = visible to this reviewer but sitting at
   * an earlier hierarchy stage — NOT the same as finished work.
   */
  const rowReviewState = (exp: Expense): ReviewRowState =>
    reviewRowState({
      isReadyNow: isPendingForCurrentReviewer(exp),
      isTerminal: isTerminalReviewStatus(exp.status),
    });

  /** Snapshot the entire Review workspace (query + page + scroll) for restoration. */
  const buildWorkspaceSnapshot = (anchorExpenseId: string | null): ReviewWorkspaceState | null => {
    if (!organizationId || !user?.id) return null;
    return {
      version: REVIEW_WORKSPACE_VERSION,
      organizationId,
      reviewerUserId: user.id,
      reviewerRole: userRole ?? "",
      query: {
        mode: reviewFilterActive ? "filtered" : "normal",
        employee: singleBar.selectedEmployee
          ? {
              userId: singleBar.selectedEmployee.user_id,
              name: singleBar.selectedEmployee.employee_name,
              employeeId: singleBar.selectedEmployee.employee_id,
              email: null,
            }
          : null,
        searchDraft: singleBar.draft,
        submittedSearch: singleBar.submitted,
        generalSearch: singleBar.generalSearch,
        statusFilter,
        timePeriod,
        sortBy,
        sortOrder,
        customFilters: customFieldFilters,
        showOnlyActionable,
        includeTeamLeaderReports,
        includeExecutiveReports,
      },
      // Persist the APPLIED page: the server page in server-query mode, the
      // client page otherwise (§36). Restore lands back on it exactly (§55).
      pagination: {
        page: reviewFilterActive ? serverPage : currentPage,
        pageSize: REVIEW_PAGE_SIZE,
      },
      scroll: { y: typeof window !== "undefined" ? window.scrollY : 0, anchorExpenseId },
      savedAt: Date.now(),
    };
  };

  /** The return-cache / workspace query identity — the APPLIED query, custom filters included (§37). */
  const currentReviewQueryKey = (): string => buildAppliedQueryKey(appliedQuery);

  const saveWorkspaceBeforeLeaving = (anchorExpenseId: string | null) => {
    const snap = buildWorkspaceSnapshot(anchorExpenseId);
    if (!snap || !organizationId || !user?.id) return;
    saveReviewWorkspaceState(snap);
    // Also cache the LIST currently on screen so Back repaints instantly (§9-§13).
    // Only safe list rows are stored; the max-row guard drops oversized normal lists.
    saveReviewReturnCache({
      version: REVIEW_RETURN_CACHE_VERSION,
      organizationId,
      reviewerUserId: user.id,
      mode: reviewFilterActive ? "filtered" : "normal",
      queryKey: currentReviewQueryKey(),
      rows: allExpenses,
      totalAvailable,
      filteredResultCount,
      allExpensesLoaded,
      truncated: Boolean(managerFetchWarning) && reviewFilterActive,
      currentPage,
      savedAt: Date.now(),
    });
    markReviewReturnPending();
  };

  const navigateToBatchReview = (batchId: string, expenseId: string) => {
    sessionStorage.setItem("engineerReview:scrollY", String(window.scrollY));
    // Persist the full workspace so Back from Review Batch returns to the same
    // employee / search / filters / sort / page / scroll (§12/§13).
    saveWorkspaceBeforeLeaving(expenseId);
    navigate(`/expenses/batch/${batchId}/review?from=review&expense=${expenseId}`);
  };

  // Per-batch review state (shared 3-state): completed=grey, ready=blue, waiting=amber.
  // Classified from the CHILDREN, not from a pending-count: a batch whose every
  // child is non-terminal but waiting at an earlier tier is WAITING (amber), not
  // "all-done" (grey) — the previous bug a Manager saw on executive-tier batches.
  const batchActionState = useMemo(() => {
    const batchGroups = new Map<string, Expense[]>();
    for (const exp of allExpenses) {
      if (!exp.batch_id) continue;
      if (!batchGroups.has(exp.batch_id)) batchGroups.set(exp.batch_id, []);
      batchGroups.get(exp.batch_id)!.push(exp);
    }
    const map = new Map<string, ReviewRowState>();
    for (const [batchId, exps] of batchGroups) {
      map.set(
        batchId,
        batchReviewState(
          exps.map((e) => ({
            isReadyNow: isPendingForCurrentReviewer(e),
            isTerminal: isTerminalReviewStatus(e.status),
          })),
        ),
      );
    }
    return map;
    // isPendingForCurrentReviewer closes over: userRole, hierarchyEnabled, teamLeaderTierEnabled, executiveTierEnabled
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allExpenses, userRole, hierarchyEnabled, teamLeaderTierEnabled, executiveTierEnabled]);

  const getExpenseReviewButtonLabel = (exp: Expense) => {
    if (
      (exp.status || "").toLowerCase() === "approved" ||
      (exp.status || "").toLowerCase() === "rejected" ||
      !isPendingForCurrentReviewer(exp)
    ) {
      return "View";
    }
    return "View/Approve";
  };

  const isActionDisabled = (exp?: Expense | null) => {
    if (!exp) return true;
    if (exp.status === "approved") return true;
    if (exp.status === "rejected") return true;
    if (!isPendingForCurrentReviewer(exp)) return true;
    if (exp.status === "verified" && Number(exp.total_amount) >= Number(engineerApprovalLimit)) {
      return true;
    }
    return false;
  };

  /**
   * A row's shared 3-state for SELECTION purposes. A batch child takes the whole
   * batch's aggregate state, so the batch selects/greys as one unit; a singular
   * row uses its own state. Terminal → not selectable (§24).
   */
  const rowSelectableState = (exp: Expense): ReviewRowState =>
    exp.batch_id ? (batchActionState.get(exp.batch_id) ?? "waiting") : rowReviewState(exp);

  const toSelectableRow = (exp: Expense): SelectableRow => ({
    id: exp.id,
    batch_id: exp.batch_id,
    state: rowSelectableState(exp),
  });

  /** Ready AND waiting rows are selectable; terminal rows are not. Batch = one key. */
  const isSelectableForBulk = (exp: Expense): boolean => isRowSelectable(toSelectableRow(exp));

  const selectionKeyFor = (exp: Expense): string => selectionKey(exp);

  const handleToggleRow = (exp: Expense, checked: boolean) => {
    const key = selectionKeyFor(exp);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    const keys = pageSelectableKeys(paginatedExpenses.map(toSelectableRow));
    setSelectedKeys(checked ? new Set(keys) : new Set());
  };

  /** Every currently-held row whose key is selected, expanded to expense ids. */
  const selectedExpenseTargets = (): Expense[] => {
    const ids = new Set(
      expandSelectionToExpenseIds(selectedKeys, allExpenses.map(toSelectableRow)),
    );
    return allExpenses.filter((e) => ids.has(e.id));
  };

  /** Selected rows that are actionable by THIS reviewer right now (not waiting/terminal). */
  const readyNowTargets = (): Expense[] =>
    selectedExpenseTargets().filter(
      (e) => isPendingForCurrentReviewer(e) && !isTerminalReviewStatus(e.status),
    );

  /**
   * Bulk Verify (DOC-098): batch selections are NEVER expanded over
   * browser-held `allExpenses` — each selected batch is verified with ONE
   * call to the server-authoritative atomic RPC, which resolves the batch's
   * current children itself and either advances all of them or none. Batches
   * are processed one at a time (not Promise.all): Review actions are
   * financial-adjacent and the server already runs under heavy load (§15).
   * Singular selections keep the existing per-expense path unchanged.
   */
  const handleBulkVerify = async () => {
    if (!user) return;
    const { batchIds, singularIds } = splitSelectedKeysBySelection(selectedKeys);
    if (batchIds.length === 0 && singularIds.length === 0) return;

    setBulkActionLoading(true);
    setBatchVerifyBlockers([]);

    const batchResults: BatchVerifyResult[] = [];
    for (const batchId of batchIds) {
      try {
        const result = await ExpenseService.verifyBatchAtomic(
          batchId,
          user.id,
          "Bulk verified",
          { reviewerRole: userRole },
        );
        batchResults.push(result);
      } catch (e) {
        batchResults.push({
          ok: false,
          batchId,
          code: "batch_verification_blocked",
          blockers: [
            {
              expenseId: "",
              transactionNumber: null,
              employeeId: null,
              status: "",
              approvalTier: null,
              reason: e instanceof Error ? e.message : "Request failed",
            },
          ],
        });
      }
    }

    // Singular expenses at this reviewer's stage; waiting/terminal skipped
    // (unchanged from before — this path never touched batch children).
    const allSelected = selectedExpenseTargets();
    const singularTargets = allSelected.filter(
      (e) =>
        !e.batch_id &&
        singularIds.includes(e.id) &&
        isPendingForCurrentReviewer(e) &&
        !isTerminalReviewStatus(e.status),
    );
    let singularSucceeded = 0;
    let singularFailed = 0;
    const failedSingularIds = new Set<string>();
    for (const exp of singularTargets) {
      try {
        await ExpenseService.verifyExpense(exp.id, user.id, "Bulk verified", {
          reviewerRole: userRole,
        });
        singularSucceeded++;
      } catch {
        singularFailed++;
        failedSingularIds.add(exp.id);
      }
    }

    setBulkActionLoading(false);

    // Selection retention (§5C): successful batches and successful singular
    // rows are removed; blocked batches and failed singular rows STAY
    // selected. Never a blanket setSelectedKeys(new Set()) on partial
    // completion — that would hide exactly what still needs attention.
    const succeededBatchIds = new Set(
      batchResults.filter((r) => r.ok).map((r) => r.batchId),
    );
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const batchId of succeededBatchIds) next.delete(`batch:${batchId}`);
      for (const exp of singularTargets) {
        if (!failedSingularIds.has(exp.id)) next.delete(`expense:${exp.id}`);
      }
      return next;
    });

    refreshCurrentReviewQuery();

    const blockedResults = batchResults.filter(
      (r): r is Extract<BatchVerifyResult, { ok: false; code: "batch_verification_blocked" }> =>
        !r.ok && r.code === "batch_verification_blocked",
    );
    if (blockedResults.length > 0) {
      setBatchVerifyBlockers(
        blockedResults.map((r) => ({ batchId: r.batchId, blockers: r.blockers })),
      );
    }

    const batchesVerified = batchResults.filter((r) => r.ok).length;
    const batchesBlocked = batchResults.length - batchesVerified;
    const verifiedExpenseCount =
      batchResults
        .filter((r): r is Extract<BatchVerifyResult, { ok: true }> => r.ok)
        .reduce((sum, r) => sum + r.verifiedCount, 0) + singularSucceeded;

    const parts: string[] = [];
    if (verifiedExpenseCount > 0) {
      const batchSuffix =
        batchesVerified > 0 ? ` across ${batchesVerified} batch${batchesVerified !== 1 ? "es" : ""}` : "";
      parts.push(`Verified ${verifiedExpenseCount} expense${verifiedExpenseCount !== 1 ? "s" : ""}${batchSuffix}`);
    }
    if (batchesBlocked > 0) {
      parts.push(
        `${batchesBlocked} batch${batchesBlocked !== 1 ? "es" : ""} could not be verified — see details`,
      );
    }
    if (singularFailed > 0) parts.push(`${singularFailed} failed`);
    toast({ title: parts.join(", ") || "Nothing to verify" });
  };

  /** Manager override is usable only when the server capability is installed AND the real limit is known (§8). */
  const overrideEffective = managerOverrideReady && approvalLimitLoaded;

  /**
   * Resolve the concrete expenses to act on at APPROVAL time (§10/§11, and the
   * DOC-098 same-day fail-closed correction below):
   *  - singular selections use the loaded row (safe — Approve remains
   *    per-expense and server-re-authorized regardless);
   *  - each selected BATCH key MUST resolve from a FRESH server fetch of its
   *    current children. A batch selection is never defined by browser-held
   *    rows: off-page / not-yet-loaded / stale children must never be silently
   *    excluded from the classification a human reviewer is about to confirm.
   *
   * FAIL-CLOSED CORRECTION: the previous implementation wrapped the fresh
   * batch fetch in a try/catch whose catch body was empty, and additionally
   * discarded the Supabase `error` entirely (destructuring only `data`) — so
   * a network failure, an RLS error, OR a non-throwing Postgrest error all
   * silently fell back to whatever partial/stale batch children happened to
   * already be loaded in the browser (`selectedExpenseTargets()`), with the
   * caller unable to tell the difference from a real, complete resolution.
   * A manager could then see (or skip straight past, if none of the partial
   * rows needed a warning) an approval dialog built from an incomplete batch.
   * This function now returns a discriminated result: on ANY batch-fetch
   * failure (thrown error OR a returned Postgrest error) the whole resolution
   * fails — nothing is merged, nothing is guessed — and the caller must stop
   * without approving anything and offer a retry. The server still
   * re-authorizes every mutation regardless; this only guarantees the
   * confirmation dialog a human approves is never silently partial.
   */
  const resolveApprovalTargets = async (): Promise<
    { ok: true; targets: Expense[] } | { ok: false }
  > => {
    const byId = new Map<string, Expense>();
    // Singular (non-batch) selections may use the loaded/current row — Approve
    // stays per-expense and is always re-authorized server-side.
    for (const e of selectedExpenseTargets()) {
      if (!e.batch_id) byId.set(e.id, e);
    }
    const batchIds: string[] = [];
    for (const key of selectedKeys) if (key.startsWith("batch:")) batchIds.push(key.slice(6));

    if (batchIds.length > 0) {
      if (!organizationId) return { ok: false };
      const { data, error } = await supabase
        .from("expenses")
        .select(
          "id, user_id, batch_id, status, approval_tier, total_amount, title, trip_start, created_at, transaction_number",
        )
        .eq("organization_id", organizationId)
        .in("batch_id", batchIds);
      if (error) return { ok: false };
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const e = toCoreExpense(row);
        byId.set(e.id, e); // fresh server row is the ONLY source for batch children
      }
    }

    // Hydrate employee identity (name/employee id) for any target missing it
    // (fresh batch-fetched rows) in ONE batched query — never N+1 (§7B). A
    // failure here degrades display only (name/employee id may show "—"); it
    // must NOT fail the whole resolution, since identity is not what the
    // ready/waiting/over-limit classification depends on.
    const needIdentity = [...byId.values()].filter((e) => !e.user_name || !e.user_employee_id);
    if (needIdentity.length > 0 && organizationId) {
      const userIds = needIdentity.map((e) => e.user_id);
      try {
        const profiles = await fetchProfilesByUserIds(
          supabase,
          organizationId,
          userIds,
          "user_id, name, employee_id",
        );
        const profileById = new Map(
          (profiles ?? []).map((p: Record<string, unknown>) => [p.user_id as string, p]),
        );
        for (const e of needIdentity) {
          const p = profileById.get(e.user_id) as Record<string, unknown> | undefined;
          if (!p) continue;
          byId.set(e.id, {
            ...e,
            user_name: (p.name as string | undefined) ?? e.user_name,
            user_employee_id: (p.employee_id as string | undefined) ?? e.user_employee_id,
          });
        }
      } catch {
        // Dialog falls back to whatever identity is already on the row.
      }
    }

    return { ok: true, targets: [...byId.values()] };
  };

  /**
   * Sequential (concurrency 1) approval. `readyIds` go through the normal V2
   * atomic path; `waitingIds` go through the Manager override RPC — callers
   * decide which set(s) to pass, so a ready-only call NEVER touches the
   * override path (§7C/§8). Never Promise.all — the same employee's rows
   * must settle in order. `closeDialog` clears the confirmation dialogs;
   * `keepSelectionForIds` are removed from the selection AFTER success,
   * leaving anything not yet processed (waiting/blocked) still selected —
   * never a blanket setSelectedKeys(new Set()) on a partial run (§5C/§8A).
   */
  const runBulkApproval = async (
    readyIds: string[],
    waitingIds: string[],
    skippedCount = 0,
    options?: { closeDialog?: boolean },
  ) => {
    if (!user || (readyIds.length === 0 && waitingIds.length === 0)) {
      if (options?.closeDialog !== false) setApprovalWarning(null);
      return;
    }
    setBulkActionLoading(true);
    let approvedNormal = 0;
    let approvedOverride = 0;
    let failed = 0;
    const processedExpenseIds = new Set<string>();
    for (const id of readyIds) {
      try {
        await ExpenseService.approveExpense(id, user!.id, "Bulk approved");
        approvedNormal++;
        processedExpenseIds.add(id);
      } catch {
        failed++;
      }
    }
    for (const id of waitingIds) {
      try {
        await ExpenseService.approveExpenseManagerOverride(id, "Bulk approved (Manager override)");
        approvedOverride++;
        processedExpenseIds.add(id);
      } catch {
        failed++;
      }
    }
    setBulkActionLoading(false);

    // Remove only the singular `expense:<id>` keys for rows that were
    // actually processed this run. Batch keys are left as-is (Approve is
    // per-expense, not batch-atomic — a batch key naturally clears once the
    // page refresh shows none of its children remain selectable).
    if (processedExpenseIds.size > 0) {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const id of processedExpenseIds) next.delete(`expense:${id}`);
        return next;
      });
    }
    if (options?.closeDialog !== false) {
      setApprovalWarning(null);
      setOverrideConfirmOpen(false);
      setApprovalWarningShowWaiting(false);
    }
    // Close the detail modal if this ran from a single open expense (no-op for
    // the bulk bar, where nothing is open).
    setSelectedExpense(null);
    refreshCurrentReviewQuery();

    const total = approvedNormal + approvedOverride;
    const parts: string[] = [];
    if (approvedOverride > 0) {
      parts.push(`${approvedNormal} approved normally, ${approvedOverride} approved with Manager override`);
    } else {
      parts.push(`${total} approved`);
    }
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failed > 0) parts.push(`${failed} failed`);
    toast({ title: parts.join(", ") });
  };

  const classifySelection = (targets: Expense[]) =>
    classifyForApproval(
      targets.map((e) => ({
        id: e.id,
        isReadyNow: isPendingForCurrentReviewer(e),
        isTerminal: isTerminalReviewStatus(e.status),
        amount: Number(e.total_amount),
      })),
      Number(engineerApprovalLimit),
    );

  const handleBulkApprove = async () => {
    if (!user) return;
    const resolution = await resolveApprovalTargets();
    if (!resolution.ok) {
      // Fail closed (DOC-098): a selected batch could not be freshly resolved —
      // show nothing, approve nothing, never fall back to a partial/stale view.
      toast({
        variant: "destructive",
        title: t("admin:review.toast.approvalResolutionFailed"),
        description: t("admin:review.toast.approvalResolutionFailedDescription"),
      });
      return;
    }
    const targets = resolution.targets;
    if (!targets.length) return;
    const classification = classifySelection(targets);
    // Anything not immediately approvable (waiting / over-limit / terminal) must be
    // confirmed first. This mutates NOTHING — the dialog decides.
    if (needsApprovalWarning(classification)) {
      const selectedTotal = targets.reduce((s, e) => s + Number(e.total_amount || 0), 0);
      setApprovalWarning({ classification, selectedTotal, mode: "bulk", targets });
      return;
    }
    await runBulkApproval(classification.readyNow, [], 0);
  };

  const handleBulkReject = async () => {
    if (!user) return;
    // Reject only rows at this reviewer's stage; waiting/terminal are skipped.
    const targets = readyNowTargets();
    if (!targets.length) return;
    setBulkActionLoading(true);
    let succeeded = 0, failed = 0;
    for (const exp of targets) {
      try {
        await ExpenseService.rejectExpense(exp.id, user!.id, "Bulk rejected");
        succeeded++;
      } catch {
        failed++;
      }
    }
    setBulkActionLoading(false);
    setSelectedKeys(new Set());
    refreshCurrentReviewQuery();
    toast({ title: `Rejected ${succeeded} expense${succeeded !== 1 ? "s" : ""}${failed ? `, ${failed} failed` : ""}` });
  };

  const getStats = () => {
    // SERVER-QUERY mode: `allExpenses` holds only the current 25-row page, so KPI
    // cards must come from the server's reconciled `filtered_summary` over the
    // WHOLE filtered population — never from the 25 held rows (§28). The Assigned
    // card uses the server filtered total (§23/§27). If a (pre-20260802030000)
    // server omits the summary, fall back to the loaded-page figures rather than
    // pretending the page is the whole result.
    if (reviewFilterActive) {
      const summary = serverFilteredSummary;
      const totalAssigned =
        filteredResultCount != null ? filteredResultCount : summary?.assigned_to_me ?? allExpenses.length;
      return {
        totalAssigned,
        pendingReview:
          summary != null
            ? summary.pending_review
            : allExpenses.filter((e) => isPendingForCurrentReviewer(e)).length,
        verified:
          summary != null
            ? summary.verified
            : allExpenses.filter((e) =>
                ["verified", "level_1_verified", "level_2_verified"].includes(e.status),
              ).length,
        approved:
          summary != null ? summary.approved : allExpenses.filter((e) => e.status === "approved").length,
        totalAmount:
          summary != null ? summary.total_amount : allExpenses.reduce((sum, e) => sum + e.total_amount, 0),
      };
    }

    const totalAssigned = allExpenses.length;
    const pendingReview = allExpenses.filter((e) => isPendingForCurrentReviewer(e)).length;
    const verified = allExpenses.filter((e) =>
      ["verified", "level_1_verified", "level_2_verified"].includes(e.status),
    ).length;
    const approved = allExpenses.filter((e) => e.status === "approved").length;
    const totalAmount = allExpenses.reduce((sum, e) => sum + e.total_amount, 0);

    return {
      totalAssigned,
      pendingReview,
      verified,
      approved,
      totalAmount,
    };
  };

  const stats = getStats();

  /**
   * Bulk Verify blocker detail (DOC-098 §5B) — replaces an aggregate-only "N
   * failed" toast with the exact transactions/employees that blocked each
   * batch and why. Nothing was mutated for any blocked batch.
   */
  const batchVerifyBlockersDialog = (
    <AlertDialog
      open={batchVerifyBlockers.length > 0}
      onOpenChange={(open) => {
        if (!open) setBatchVerifyBlockers([]);
      }}
    >
      <AlertDialogContent data-testid="batch-verify-blockers-dialog" className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("admin:review.batchVerifyBlockers.title", { count: batchVerifyBlockers.length })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:review.batchVerifyBlockers.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="max-h-72 rounded border" data-testid="batch-verify-blockers-list">
          <div className="divide-y">
            {batchVerifyBlockers.map(({ batchId, blockers }) => (
              <div key={batchId} className="p-2 text-xs">
                <div className="font-medium text-muted-foreground">
                  {blockers[0]?.employeeId
                    ? `${t("admin:review.approvalWarning.employeeIdShort")} ${blockers[0].employeeId}`
                    : batchId}
                </div>
                {blockers.map((b, i) => (
                  <div key={`${b.expenseId || i}`} className="mt-1">
                    <span className="font-medium">#{b.transactionNumber || "—"}</span>{" "}
                    <span className="text-amber-700">
                      {b.approvalTier
                        ? waitingReasonLabel({ approval_tier: b.approvalTier, status: b.status })
                        : b.reason}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => setBatchVerifyBlockers([])}
            data-testid="batch-verify-blockers-close"
          >
            {t("admin:review.batchVerifyBlockers.close")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  /** Waiting-item rows resolved from `approvalWarning.targets`, richest-detail-first (§7A/§7B). */
  const approvalWarningWaitingItems: Expense[] = approvalWarning
    ? approvalWarning.targets.filter((e) => approvalWarning.classification.waiting.includes(e.id))
    : [];

  const approveReadyOnly = () => {
    if (!approvalWarning) return;
    const c = approvalWarning.classification;
    const skipped = c.overLimit.length + c.terminal.length + c.waiting.length;
    // Ready-only: NEVER calls Manager Override, NEVER mutates a waiting row (§7C/§8).
    void runBulkApproval(c.readyNow, [], skipped, { closeDialog: false });
  };

  const confirmManagerOverride = () => {
    if (!approvalWarning) return;
    const c = approvalWarning.classification;
    void runBulkApproval([], c.waiting, 0, { closeDialog: false });
    setOverrideConfirmOpen(false);
  };

  /**
   * Shared pre-approval warning dialog (desktop + mobile). Rendering it while
   * `approvalWarning` is set has mutated nothing. "Approve N ready now" is the
   * primary action and only ever approves classification.readyNow — zero
   * Manager Override calls, zero waiting-row mutation. Manager Override is a
   * separate secondary action gated behind its own explicit second
   * confirmation (§7).
   */
  const approvalWarningDialog = (
    <AlertDialog
      open={approvalWarning != null && !overrideConfirmOpen}
      onOpenChange={(open) => {
        if (!open) {
          setApprovalWarning(null);
          setApprovalWarningShowWaiting(false);
        }
      }}
    >
      <AlertDialogContent data-testid="approval-warning-dialog" className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:review.approvalWarning.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {approvalWarning?.mode === "single"
              ? t("admin:review.approvalWarning.descriptionSingle")
              : t("admin:review.approvalWarning.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {approvalWarning && (
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span>{t("admin:review.approvalWarning.readyNow")}</span>
              <span className="font-medium text-green-700" data-testid="approval-warning-ready">
                {approvalWarning.classification.readyNow.length}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>{t("admin:review.approvalWarning.waiting")}</span>
              <span className="flex items-center gap-2">
                <span className="font-medium text-amber-700" data-testid="approval-warning-waiting">
                  {approvalWarning.classification.waiting.length}
                </span>
                {approvalWarning.classification.waiting.length > 0 && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setApprovalWarningShowWaiting((v) => !v)}
                    data-testid="approval-warning-view-waiting"
                  >
                    {approvalWarningShowWaiting
                      ? t("admin:review.approvalWarning.hideWaiting")
                      : t("admin:review.approvalWarning.viewWaiting", {
                          count: approvalWarning.classification.waiting.length,
                        })}
                  </Button>
                )}
              </span>
            </div>
            {approvalWarningShowWaiting && approvalWarningWaitingItems.length > 0 && (
              <ScrollArea className="max-h-48 rounded border" data-testid="approval-warning-waiting-list">
                <div className="divide-y">
                  {approvalWarningWaitingItems.map((item) => (
                    <div key={item.id} className="p-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          #{(item as unknown as { transaction_number?: string }).transaction_number || "—"}
                        </span>
                        {item.batch_id && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("admin:review.approvalWarning.batchBadge")}
                          </Badge>
                        )}
                      </div>
                      <div className="text-muted-foreground">
                        {item.user_name || "—"}
                        {item.user_employee_id ? ` · ${t("admin:review.approvalWarning.employeeIdShort")} ${item.user_employee_id}` : ""}
                      </div>
                      <div className="text-amber-700">{waitingReasonLabel(item)}</div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
            <div className="flex justify-between">
              <span>{t("admin:review.approvalWarning.overLimit")}</span>
              <span className="font-medium text-red-700" data-testid="approval-warning-overlimit">
                {approvalWarning.classification.overLimit.length}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t("admin:review.approvalWarning.completed")}</span>
              <span className="font-medium text-muted-foreground" data-testid="approval-warning-completed">
                {approvalWarning.classification.terminal.length}
              </span>
            </div>
            <div className="mt-2 flex justify-between border-t pt-2">
              <span>{t("admin:review.approvalWarning.selectedTotal")}</span>
              <span className="font-semibold">{formatINR(approvalWarning.selectedTotal)}</span>
            </div>
            {approvalWarning.classification.waiting.length > 0 && !overrideEffective && (
              <p
                className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
                data-testid="approval-warning-override-note"
              >
                {t("admin:review.approvalWarning.overrideUnavailable")}
              </p>
            )}
          </div>
        )}
        <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Button
            variant="outline"
            onClick={() => {
              setApprovalWarning(null);
              setApprovalWarningShowWaiting(false);
            }}
            disabled={bulkActionLoading}
            data-testid="approval-warning-stop"
          >
            {t("admin:review.approvalWarning.stop")}
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            {overrideEffective && (approvalWarning?.classification.waiting.length ?? 0) > 0 && (
              <Button
                type="button"
                variant="outline"
                className="border-amber-400 text-amber-800 hover:bg-amber-50"
                onClick={() => setOverrideConfirmOpen(true)}
                disabled={bulkActionLoading}
                data-testid="approval-warning-override-open"
              >
                {t("admin:review.approvalWarning.managerOverride", {
                  count: approvalWarning?.classification.waiting.length ?? 0,
                })}
              </Button>
            )}
            <Button
              onClick={approveReadyOnly}
              disabled={
                (approvalWarning?.classification.readyNow.length ?? 0) === 0 || bulkActionLoading
              }
              data-testid="approval-warning-proceed"
            >
              {t("admin:review.approvalWarning.approveReadyNow", {
                count: approvalWarning?.classification.readyNow.length ?? 0,
              })}
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  /**
   * Second explicit confirmation before ANY Manager Override RPC runs (§7G).
   * Lists every waiting item by name so the reviewer sees exactly what
   * they're bypassing normal verification for. Cancel returns to the primary
   * dialog with zero mutation.
   */
  const managerOverrideConfirmDialog = (
    <AlertDialog
      open={overrideConfirmOpen}
      onOpenChange={(open) => {
        if (!open) setOverrideConfirmOpen(false);
      }}
    >
      <AlertDialogContent data-testid="override-confirm-dialog" className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("admin:review.overrideConfirm.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("admin:review.overrideConfirm.description", {
              count: approvalWarning?.classification.waiting.length ?? 0,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ScrollArea className="max-h-64 rounded border" data-testid="override-confirm-list">
          <div className="divide-y">
            {approvalWarningWaitingItems.map((item) => (
              <div key={item.id} className="p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    #{(item as unknown as { transaction_number?: string }).transaction_number || "—"}
                  </span>
                  {item.batch_id && (
                    <Badge variant="outline" className="text-[10px]">
                      {t("admin:review.approvalWarning.batchBadge")}
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground">
                  {item.user_name || "—"}
                  {item.user_employee_id ? ` · ${t("admin:review.approvalWarning.employeeIdShort")} ${item.user_employee_id}` : ""}
                </div>
                <div className="text-amber-700">{waitingReasonLabel(item)}</div>
              </div>
            ))}
          </div>
        </ScrollArea>
        <AlertDialogFooter>
          <Button
            variant="outline"
            onClick={() => setOverrideConfirmOpen(false)}
            disabled={bulkActionLoading}
            data-testid="override-confirm-cancel"
          >
            {t("admin:review.overrideConfirm.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={confirmManagerOverride}
            disabled={bulkActionLoading}
            data-testid="override-confirm-proceed"
          >
            {t("admin:review.overrideConfirm.confirm", {
              count: approvalWarning?.classification.waiting.length ?? 0,
            })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // ── Pagination ──────────────────────────────────────────────────────────────
  // SERVER-QUERY mode pages at the server (one 25-row page per request); NORMAL
  // mode slices the loaded scope client-side. In server mode `expenses` IS the
  // current page, so it is not re-sliced.
  const totalPages = reviewFilterActive
    ? Math.max(1, serverTotalPages || 1)
    : Math.max(1, Math.ceil(expenses.length / REVIEW_PAGE_SIZE));
  const safeCurrentPage = reviewFilterActive
    ? Math.min(serverPage, totalPages)
    : Math.min(currentPage, totalPages);
  const pageStartIndex = reviewFilterActive ? 0 : (safeCurrentPage - 1) * REVIEW_PAGE_SIZE;
  const paginatedExpenses = reviewFilterActive
    ? expenses
    : expenses.slice(pageStartIndex, pageStartIndex + REVIEW_PAGE_SIZE);

  const getVisiblePageNumbers = (): (number | "…")[] => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "…")[] = [1];
    if (safeCurrentPage > 3) pages.push("…");
    for (let p = Math.max(2, safeCurrentPage - 1); p <= Math.min(totalPages - 1, safeCurrentPage + 1); p++) {
      pages.push(p);
    }
    if (safeCurrentPage < totalPages - 2) pages.push("…");
    pages.push(totalPages);
    return pages;
  };
  // ────────────────────────────────────────────────────────────────────────────

  if (userRole !== "engineer" && !isHierarchyReviewer) {
    return (
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">{t("common:accessDenied.title")}</h1>
          <p className="text-muted-foreground">{t("common:accessDenied.defaultDescription")}</p>
        </div>
      </div>
    );
  }

  if (isMobile) {
    if (selectedExpense && reviewExpense) {
      return (
        <>
          <MobileReviewDetailView
            expense={reviewExpense}
            attachments={attachments}
            lineItems={lineItems}
            auditLogs={auditLogs}
            correctionLogs={correctionLogs}
            timelineAssignees={timelineAssignees}
            engineerComment={engineerComment}
            setEngineerComment={setEngineerComment}
            reviewLoading={reviewLoading}
            canApprove={canApprove}
            canCorrect={canEngineerCorrectExpense(reviewExpense)}
            isActionDisabled={isActionDisabled(reviewExpense)}
            engineerApprovalLimit={engineerApprovalLimit}
            employeeIdLoginEnabled={employeeIdLoginEnabled}
            hierarchyEnabled={hierarchyEnabled}
            teamLeaderTierEnabled={teamLeaderTierEnabled}
            executiveTierEnabled={executiveTierEnabled}
            roleLabels={roleLabels}
            organizationId={organizationId}
            correctionDialogOpen={correctionDialogOpen}
            setCorrectionDialogOpen={setCorrectionDialogOpen}
            correctionLoading={correctionLoading}
            corrTitle={corrTitle} setCorrTitle={setCorrTitle}
            corrDestination={corrDestination} setCorrDestination={setCorrDestination}
            corrExpenseDate={corrExpenseDate} setCorrExpenseDate={setCorrExpenseDate}
            corrPurpose={corrPurpose} setCorrPurpose={setCorrPurpose}
            corrCategory={corrCategory} setCorrCategory={setCorrCategory}
            corrAmount={corrAmount} setCorrAmount={setCorrAmount}
            corrAdminComment={corrAdminComment} setCorrAdminComment={setCorrAdminComment}
            correctionReason={correctionReason} setCorrectionReason={setCorrectionReason}
            corrFieldModel={corrFieldModel}
            onCorrFormFieldValuesChange={(vals) => setCorrFieldModel((prev) => ({ ...prev, formFieldValues: vals }))}
            onCorrBranchValuesChange={(vals) => setCorrFieldModel((prev) => ({ ...prev, branchValues: vals }))}
            onBack={() => {
              setSelectedExpense(null);
              setEngineerComment("");
              setLineItems([]);
              setAttachments([]);
              setAuditLogs([]);
              setCorrectionLogs([]);
              setTimelineAssignees({});
              setCorrectionDialogOpen(false);
            }}
            onVerify={() => void verifyExpense()}
            onApprove={() => void approveExpense()}
            onReject={() => void rejectExpense()}
            onCorrect={openCorrectionDialog}
            onSubmitCorrection={() => void submitExpenseCorrection()}
            onPreviewAttachment={(url, contentType, uploadedBy) => {
              setImagePreviewUrl(url);
              setPreviewContentType(contentType);
              setPreviewUploadedBy(uploadedBy);
              setImagePreviewOpen(true);
            }}
          />
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

    return (
      <>
        {selectedKeys.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2 mb-3">
            <span className="text-sm font-medium text-blue-700 dark:text-blue-300 flex-1">
              {selectedKeys.size} selected
            </span>
            <Button size="sm" variant="outline" className="text-green-700 border-green-300 h-7 px-2 text-xs"
              onClick={handleBulkVerify} disabled={bulkActionLoading}>
              <CheckCircle className="w-3 h-3 mr-1" /> Verify
            </Button>
            {canApprove && (
              <Button size="sm" variant="outline" className="text-blue-700 border-blue-300 h-7 px-2 text-xs"
                onClick={handleBulkApprove} disabled={bulkActionLoading}>
                <CheckCircle className="w-3 h-3 mr-1" /> Approve
              </Button>
            )}
            <Button size="sm" variant="outline" className="text-red-700 border-red-300 h-7 px-2 text-xs"
              onClick={handleBulkReject} disabled={bulkActionLoading}>
              <XCircle className="w-3 h-3 mr-1" /> Reject
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"
              onClick={() => setSelectedKeys(new Set())} disabled={bulkActionLoading}>
              Clear
            </Button>
          </div>
        )}
        {backgroundRefreshing && (
          <AsyncOperationProgress status="running" title="Refreshing…" compact className="mb-2" />
        )}
        <MobileReviewQueueView
          expenses={expenses}
          loading={loading && allExpenses.length === 0}
          searchTerm={searchTerm}
          setSearchTerm={setSearchTerm}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          timePeriod={timePeriod}
          setTimePeriod={setTimePeriod}
          managerFetchWarning={managerFetchWarning}
          isPendingForCurrentReviewer={isPendingForCurrentReviewer}
          formatSubline={formatEmployeeSubline}
          isSelectableForBulk={isSelectableForBulk}
          selectedKeys={selectedKeys}
          selectionKeyOf={selectionKeyFor}
          onToggleSelect={handleToggleRow}
          bulkActionLoading={bulkActionLoading}
          onSelectExpense={async (expense) => {
            if (expense.batch_id) {
              navigateToBatchReview(expense.batch_id, expense.id);
              return;
            }
            setSelectedExpense(expense);
            void fetchExpenseDetails(expense.id, expense);
            await fetchEngineerApprovalLimit();
          }}
        />
        {approvalWarningDialog}
        {managerOverrideConfirmDialog}
        {batchVerifyBlockersDialog}
      </>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 lg:space-y-8">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3 sm:gap-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{t("admin:review.title")}</h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-1">
            {t("admin:review.description")}
          </p>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin:review.assignedToMe")}</CardTitle>
            <Receipt className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.totalAssigned}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin:review.pendingReview")}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pendingReview}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin:review.verified")}</CardTitle>
            <CheckCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.verified}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t("admin:review.totalAmount")}</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatINR(stats.totalAmount, moneyLocale)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Expenses Table */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-lg sm:text-xl">{t("admin:review.assignedExpenses")}</CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            {t("admin:review.assignedExpensesDescription")}
            {(userRole === "engineer" || isHierarchyReviewer) && (
              <span className="block mt-1 text-muted-foreground">
                {t("admin:review.approvedStayVisible")}
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 sm:p-6">
          {managerFetchWarning ? (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {managerFetchWarning}
            </div>
          ) : null}
          {/* Search and Filter Bar */}
          <div className="flex flex-col sm:flex-row gap-3 mb-6">
            {/* Single search bar — one input, employee lookup + expense text
                underneath (DOC-080 §7). Same position/width as before. */}
            <ReviewSearchBar
              draft={singleBar.draft}
              onDraftChange={singleBar.setDraft}
              onSubmit={handleSubmitReviewQuery}
              onClearAll={() => {
                // Explicit clear returns to normal mode; drop any saved workspace
                // so a later return-intent cannot restore the just-cleared query (§41).
                singleBar.clearAll();
                setFilteredResultCount(null);
                setServerQueryError(null);
                setLoadError(null);
                if (organizationId && user?.id) {
                  clearReviewWorkspaceState(organizationId, user.id);
                  clearReviewReturnCache(organizationId, user.id);
                }
              }}
              searching={singleBar.state === "searching"}
              selectedEmployee={singleBar.selectedEmployee}
              selectedEmployeeCount={filteredResultCount}
              countError={Boolean(serverQueryError)}
              generalSearch={singleBar.generalSearch}
              onClearEmployee={singleBar.clearEmployee}
              onClearGeneralSearch={singleBar.clearGeneralSearch}
            >
              {singleBar.state === "choose_employee" && (
                <ReviewEmployeeResultsPopover
                  matches={singleBar.matches}
                  submitted={singleBar.submitted}
                  onSelect={singleBar.chooseEmployee}
                  onSearchExpensesInstead={singleBar.searchExpensesInstead}
                  onDismiss={singleBar.clearAll}
                />
              )}
            </ReviewSearchBar>

            {/* Status Filter — writes to DRAFT only; applies on Search (§7). */}
            <div className="w-full sm:w-40">
              <Select value={draftStatus} onValueChange={setDraftStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="submitted">Submitted</SelectItem>
                  <SelectItem value="edited">Adjusted</SelectItem>
                  <SelectItem value="level_1_verified">{t("expenses:status.level1Verified")}</SelectItem>
                  <SelectItem value="level_2_verified">{t("expenses:status.level2Verified")}</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex w-full sm:w-auto items-center gap-2">
              <Select value={draftSortBy} onValueChange={setDraftSortBy}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_at">Date Created</SelectItem>
                  <SelectItem value="trip_start">Expense Date</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setDraftSortOrder(draftSortOrder === "asc" ? "desc" : "asc")}
                aria-label={draftSortOrder === "asc" ? "Sort ascending" : "Sort descending"}
              >
                {draftSortOrder === "asc" ? "↑" : "↓"}
              </Button>
            </div>

            {/* Time Period Dropdown */}
            <div className="w-full sm:w-40">
              <Select value={draftTimePeriod} onValueChange={setDraftTimePeriod}>
                <SelectTrigger>
                  <SelectValue placeholder="Time Period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Time</SelectItem>
                  <SelectItem value="week">Past Week</SelectItem>
                  <SelectItem value="month">Past Month</SelectItem>
                  <SelectItem value="year">Past Year</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {userRole === "engineer" && hierarchyEnabled && (teamLeaderTierEnabled || executiveTierEnabled) && (
            <div className="mb-4 space-y-3 rounded-lg border bg-muted/30 p-4">
              <p className="text-sm font-medium">Who to include</p>
              <p className="text-xs text-muted-foreground">
                You always see expenses for your team (if you are set as Manager on the team) and
                employees who report to you. Use &quot;Needs my verification&quot; to show only rows
                ready for you after Executive approval (including items still labeled Submitted).
              </p>
              <label className="flex items-center gap-2 text-sm cursor-pointer font-medium">
                <Checkbox
                  checked={draftShowOnlyActionable}
                  onCheckedChange={(v) => setDraftShowOnlyActionable(v === true)}
                />
                Needs my verification only
              </label>
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                {teamLeaderTierEnabled && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={draftIncludeTeamLeaderReports}
                      onCheckedChange={(v) => setDraftIncludeTeamLeaderReports(v === true)}
                    />
                    Include {getRoleLabel("team_leader", roleLabels)} expenses
                  </label>
                )}
                {executiveTierEnabled && (
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={draftIncludeExecutiveReports}
                      onCheckedChange={(v) => setDraftIncludeExecutiveReports(v === true)}
                    />
                    Include {getRoleLabel("executive", roleLabels)} expenses
                  </label>
                )}
              </div>
            </div>
          )}
          {/* Custom field filters — DRAFT only; server-resolved on Search (§19). */}
          <ExpenseCustomFieldFilters
            fields={displayFilterableCustomFields}
            values={draftCustomFieldFilters}
            onChange={setDraftCustomFieldFilters}
            className="mb-2"
          />
          {draftDiffersFromApplied && (
            <p
              className="mb-6 text-xs font-medium text-amber-600 dark:text-amber-400"
              data-testid="review-unsaved-filters"
            >
              {t("review.unsavedFilters", {
                defaultValue: "Filters changed — press Search to apply.",
              })}
            </p>
          )}
          {/* Bulk action toolbar */}
          {selectedKeys.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-4 py-2 mb-3">
              <span className="text-sm font-medium text-blue-700 dark:text-blue-300 flex-1">
                {selectedKeys.size} expense{selectedKeys.size > 1 ? "s" : ""} selected
              </span>
              <Button size="sm" variant="outline" className="text-green-700 border-green-300"
                onClick={handleBulkVerify} disabled={bulkActionLoading}>
                <CheckCircle className="w-4 h-4 mr-1" /> Verify
              </Button>
              {canApprove && (
                <Button size="sm" variant="outline" className="text-blue-700 border-blue-300"
                  onClick={handleBulkApprove} disabled={bulkActionLoading}>
                  <CheckCircle className="w-4 h-4 mr-1" /> Approve
                </Button>
              )}
              <Button size="sm" variant="outline" className="text-red-700 border-red-300"
                onClick={handleBulkReject} disabled={bulkActionLoading}>
                <XCircle className="w-4 h-4 mr-1" /> Reject
              </Button>
              <Button size="sm" variant="ghost"
                onClick={() => setSelectedKeys(new Set())} disabled={bulkActionLoading}>
                Clear
              </Button>
            </div>
          )}
          {backgroundRefreshing && (
            <AsyncOperationProgress status="running" title="Refreshing…" compact className="mb-2" />
          )}
          {loading && allExpenses.length === 0 ? (
            <div className="min-h-[400px] flex items-center justify-center">
              <AsyncOperationProgress status="running" title="Loading expenses…" />
            </div>
          ) : expenses.length === 0 ? (
            <div className="text-center py-8">
              <Receipt className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">{t("admin:review.noAssignedTitle")}</h3>
              <p className="text-muted-foreground max-w-md mx-auto">
                {statusFilter === "level_2_verified" &&
                  userRole === "engineer" &&
                  allExpenses.some((e) => e.status === "level_1_verified") ? (
                  <>
                    No Level 2 Verified expenses in this view. You have{" "}
                    {allExpenses.filter((e) => e.status === "level_1_verified").length} at Level 1
                    (waiting for Executive). Set Status to &quot;All Statuses&quot; or ask Executive
                    to verify first.
                  </>
                ) : isHierarchyReviewer && hierarchyEnabled ? (
                  userRole === "team_leader" && !teamLeaderTierEnabled
                    ? t("admin:review.noAssignedTeamLeaderTierDisabled", {
                      role: getRoleLabel("team_leader", roleLabels),
                    })
                    : t("admin:review.noAssignedHierarchyHint", {
                      role: getRoleLabel(
                        userRole === "team_leader" ? "team_leader" : "executive",
                        roleLabels,
                      ),
                    })
                ) : (
                  t("admin:review.noAssignedDefault")
                )}
              </p>
            </div>
          ) : (
            <div data-testid="engineer-review-scroll-container" className="relative w-full overflow-x-auto -mx-4 sm:mx-0">
              <Table noScrollWrapper className="min-w-max">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10 px-2">
                      {(() => {
                        const allState = selectAllState(
                          selectedKeys,
                          paginatedExpenses.map(toSelectableRow),
                        );
                        return (
                          <Checkbox
                            checked={
                              allState === "all"
                                ? true
                                : allState === "some"
                                  ? "indeterminate"
                                  : false
                            }
                            onCheckedChange={(checked) => handleSelectAll(!!checked)}
                            disabled={bulkActionLoading}
                            aria-label="Select all"
                          />
                        );
                      })()}
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden whitespace-nowrap" style={{ width: reviewColWidth("txn"), minWidth: reviewColWidth("txn") }}>
                      Txn #
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("txn", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden" style={{ width: reviewColWidth("employee"), minWidth: reviewColWidth("employee") }}>
                      Employee / Employee ID
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("employee", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden hidden sm:table-cell" style={{ width: reviewColWidth("title"), minWidth: reviewColWidth("title") }}>
                      Title
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("title", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden hidden md:table-cell" style={{ width: reviewColWidth("category"), minWidth: reviewColWidth("category") }}>
                      Category
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("category", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden hidden sm:table-cell" style={{ width: reviewColWidth("destination"), minWidth: reviewColWidth("destination") }}>
                      Destination
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("destination", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden whitespace-nowrap" style={{ width: reviewColWidth("amount"), minWidth: reviewColWidth("amount") }}>
                      Amount
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("amount", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden hidden md:table-cell" style={{ width: reviewColWidth("balance"), minWidth: reviewColWidth("balance") }}>
                      {t("admin:review.employeeBalance")}
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("balance", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden hidden sm:table-cell" style={{ width: reviewColWidth("status"), minWidth: reviewColWidth("status") }}>
                      Status
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("status", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden whitespace-nowrap text-right pr-2 sm:pr-4 hidden sm:table-cell" style={{ width: reviewColWidth("expense_date"), minWidth: reviewColWidth("expense_date") }}>
                      Expense Date
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("expense_date", e)} />
                    </TableHead>
                    <TableHead className="relative group/th overflow-hidden whitespace-nowrap text-right pr-2 sm:pr-4 hidden md:table-cell" style={{ width: reviewColWidth("date_created"), minWidth: reviewColWidth("date_created") }}>
                      Date Created
                      <div className={resizeHandleClass} onMouseDown={(e) => reviewStartResize("date_created", e)} />
                    </TableHead>
                    <TableHead data-testid="engineer-review-actions-header" className="sticky right-0 z-30 min-w-[150px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right">Status / Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedExpenses.map((expense) => (
                    <TableRow key={expense.id} data-expense-id={expense.id} className="group">
                      <TableCell className="w-10 px-2" onClick={(e) => e.stopPropagation()}>
                        {isSelectableForBulk(expense) && (
                          <Checkbox
                            checked={selectedKeys.has(selectionKeyFor(expense))}
                            onCheckedChange={(checked) => handleToggleRow(expense, !!checked)}
                            disabled={bulkActionLoading}
                            aria-label={expense.batch_id ? "Select batch" : "Select expense"}
                          />
                        )}
                      </TableCell>
                      <TableCell className="text-xs sm:text-sm font-mono font-semibold text-blue-600 whitespace-nowrap">
                        {(expense as any).transaction_number || '-'}
                      </TableCell>
                      <TableCell className="text-xs sm:text-sm">
                        <div>
                          <div className="font-medium truncate">{expense.user_name}</div>
                          <div
                            className={`text-xs truncate ${employeeIdLoginEnabled && expense.user_employee_id
                                ? "font-mono font-medium text-foreground"
                                : "text-muted-foreground"
                              }`}
                          >
                            {formatEmployeeSubline(expense)}
                          </div>
                          {!employeeIdLoginEnabled && (
                            <div className="text-xs text-muted-foreground truncate sm:hidden">{expense.user_email}</div>
                          )}
                          <div
                            className={`text-xs sm:hidden mt-1 font-medium ${expense.user_balance >= expense.total_amount
                                ? "text-green-600"
                                : "text-red-600"
                              }`}
                          >
                            {t("admin:review.employeeBalance")}: {formatINR(expense.user_balance)}
                          </div>
                          <div className="font-medium text-xs sm:text-sm mt-1 line-clamp-1 break-words sm:hidden">{expense.title}</div>
                          {expense.batch_id && (
                            <Badge variant="outline" className="text-xs mt-1 bg-violet-50 text-violet-700 border-violet-200">
                              Batch
                            </Badge>
                          )}
                          <div className="text-xs text-muted-foreground sm:hidden mt-1">{expense.destination}</div>
                          <div className="text-xs text-muted-foreground sm:hidden mt-1">
                            Expense: {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                          </div>
                          <div className="text-xs text-muted-foreground sm:hidden">
                            {t("admin:panel.searchFilter.dateCreated")}: {formatCreatedDateTime(expense.created_at)}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-medium text-xs sm:text-sm hidden sm:table-cell">
                        <div className="line-clamp-2 break-words">{expense.title}</div>
                      </TableCell>
                      <TableCell className="text-xs sm:text-sm hidden md:table-cell capitalize">{expense.category ?? "—"}</TableCell>
                      <TableCell className="text-xs sm:text-sm truncate hidden sm:table-cell max-w-[140px]" title={expense.destination}>{expense.destination}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs sm:text-sm font-medium">{formatINR(expense.total_amount)}</TableCell>
                      <TableCell className="text-xs sm:text-sm hidden md:table-cell">
                        <div
                          className={`font-medium whitespace-nowrap ${expense.user_balance >= expense.total_amount
                              ? "text-green-600"
                              : "text-red-600"
                            }`}
                        >
                          {formatINR(expense.user_balance)}
                        </div>
                        {expense.user_balance < expense.total_amount && (
                          <div className="text-xs text-red-500 whitespace-nowrap">
                            {t("admin:review.insufficientBalance")}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {(expense as any).isResubmitted && (expense.status === "submitted" || expense.status === "edited") ? (
                          <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                            Resubmitted
                          </Badge>
                        ) : (
                          <div className="space-y-1">
                            <ExpenseStatusWithCorrectionBadge
                              status={expense.status}
                              wasReviewerCorrected={(expense as any).wasReviewerCorrected}
                              viewerContext="reviewer"
                            />
                            {getExpenseQueueHint(expense) ? (
                              <p className="text-[10px] text-muted-foreground leading-tight">
                                {getExpenseQueueHint(expense)}
                              </p>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden sm:table-cell">
                        {format(parseLocalDate(expense.trip_start) ?? new Date(expense.trip_start), "MMM d, yyyy")}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs sm:text-sm text-right pr-2 sm:pr-4 hidden md:table-cell">
                        {formatCreatedDateTime(expense.created_at)}
                      </TableCell>
                      <TableCell data-testid="engineer-review-actions-cell" className="sticky right-0 z-20 min-w-[150px] border-l bg-background group-hover:bg-muted text-right">
                        <div className="flex flex-col sm:flex-row items-end gap-2 sm:gap-0">
                          <div className="sm:hidden mb-2">
                            {(expense as any).isResubmitted && (expense.status === "submitted" || expense.status === "edited") ? (
                              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                                Resubmitted
                              </Badge>
                            ) : (
                              <ExpenseStatusWithCorrectionBadge
                                status={expense.status}
                                wasReviewerCorrected={(expense as any).wasReviewerCorrected}
                                viewerContext="reviewer"
                              />
                            )}
                          </div>
                          <div className="flex justify-end shrink-0">
                            {expense.batch_id ? (
                              <Button
                                variant={
                                  reviewStatePresentation(
                                    batchActionState.get(expense.batch_id) ?? "waiting",
                                  ).variant
                                }
                                size="sm"
                                className={
                                  reviewStatePresentation(
                                    batchActionState.get(expense.batch_id) ?? "waiting",
                                  ).className
                                }
                                onClick={() => navigateToBatchReview(expense.batch_id!, expense.id)}
                              >
                                Review batch
                              </Button>
                            ) : (
                              <Dialog>
                                <DialogTrigger asChild>
                                  <Button
                                    variant={reviewStatePresentation(rowReviewState(expense)).variant}
                                    size="sm"
                                    className={
                                      reviewStatePresentation(rowReviewState(expense)).className
                                    }
                                    onClick={async () => {
                                      setSelectedExpense(expense);
                                      fetchExpenseDetails(expense.id, expense);
                                      await fetchEngineerApprovalLimit();
                                    }}
                                  >
                                    {getExpenseReviewButtonLabel(expense)}
                                  </Button>
                                </DialogTrigger>
                                <DialogContent className="max-w-[95vw] sm:max-w-4xl max-h-[95vh] sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6">
                                  <DialogHeader>
                                    <DialogTitle className="text-lg sm:text-xl">Expense Review</DialogTitle>
                                    <DialogDescription className="text-xs sm:text-sm">
                                      Review expense details and verify the submission
                                    </DialogDescription>
                                  </DialogHeader>

                                  {selectedExpense && (
                                    <div className="space-y-6">
                                      {/* Basic Info */}
                                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <Card>
                                          <CardHeader className="pb-3">
                                            <CardTitle className="text-base">Employee Information</CardTitle>
                                          </CardHeader>
                                          <CardContent>
                                            <div className="space-y-2">
                                              <div className="flex items-center gap-2">
                                                <User className="h-4 w-4 text-muted-foreground" />
                                                <span className="font-medium">{selectedExpense.user_name}</span>
                                              </div>
                                              <div className="text-sm text-muted-foreground">
                                                {employeeIdLoginEnabled
                                                  ? (selectedExpense.user_employee_id?.trim() || "—")
                                                  : selectedExpense.user_email}
                                              </div>
                                              {employeeIdLoginEnabled && selectedExpense.user_employee_id?.trim() && (
                                                <div className="text-xs text-muted-foreground">
                                                  {selectedExpense.user_email}
                                                </div>
                                              )}
                                              <div className="pt-2 border-t mt-2">
                                                <p className="text-xs text-muted-foreground">
                                                  {t("admin:review.employeeBalance")}
                                                </p>
                                                <p
                                                  className={`text-base font-semibold ${selectedExpense.user_balance >= selectedExpense.total_amount
                                                      ? "text-green-600"
                                                      : "text-red-600"
                                                    }`}
                                                >
                                                  {formatINR(selectedExpense.user_balance)}
                                                </p>
                                                {selectedExpense.user_balance < selectedExpense.total_amount && (
                                                  <p className="text-xs text-red-500">
                                                    {t("admin:review.insufficientBalance")}
                                                  </p>
                                                )}
                                              </div>
                                            </div>
                                          </CardContent>
                                        </Card>

                                        <Card>
                                          <CardHeader className="pb-3">
                                            <CardTitle className="text-base">Expense Summary</CardTitle>
                                          </CardHeader>
                                          <CardContent>
                                            <div className="space-y-2">
                                              <div className="flex items-center gap-2">
                                                <Coins className="h-4 w-4 text-muted-foreground" />
                                                <span className="text-lg font-semibold">
                                                  {formatINR(selectedExpense.total_amount)}
                                                </span>
                                              </div>
                                              <div className="flex flex-wrap items-center gap-2">
                                                <ExpenseStatusWithCorrectionBadge
                                                  status={selectedExpense.status}
                                                  wasReviewerCorrected={(selectedExpense as any).wasReviewerCorrected}
                                                  viewerContext="reviewer"
                                                />
                                              </div>
                                              {selectedExpense.status === "level_2_verified" && (
                                                <p className="text-xs text-indigo-700 font-medium">
                                                  Executive step complete — you can now Approve or Reject this expense.
                                                </p>
                                              )}
                                            </div>
                                          </CardContent>
                                        </Card>
                                      </div>

                                      {/* Trip Details */}
                                      <Card>
                                        <CardHeader className="pb-3">
                                          <CardTitle className="text-base">Trip Details</CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-3">
                                          <ExpenseBaseFieldsDisplay
                                            organizationId={organizationId}
                                            values={{
                                              title: selectedExpense.title,
                                              destination: selectedExpense.destination,
                                              purpose: selectedExpense.purpose,
                                              expense_date: format(
                                                parseLocalDate(selectedExpense.trip_start) ?? new Date(selectedExpense.trip_start),
                                                "MMM d, yyyy",
                                              ),
                                            }}
                                            context="review"
                                          />

                                          {reviewExpense && organizationId && (
                                            <ExpenseFormFieldsDisplay
                                              key={`${reviewExpense.id}-${Object.keys(reviewExpense.custom_fields ?? {}).sort().join(",")}`}
                                              expenseId={reviewExpense.id}
                                              organizationId={organizationId}
                                              context="review"
                                              prefetchedFields={reviewExpense.custom_fields}
                                              className="space-y-3 pt-3 border-t"
                                            />
                                          )}
                                        </CardContent>
                                      </Card>

                                      {/* Line Items */}
                                      <Card>
                                        <CardHeader className="pb-3">
                                          <CardTitle className="text-base flex items-center gap-2">
                                            <FileText className="h-4 w-4" />
                                            Expense Line Items
                                          </CardTitle>
                                        </CardHeader>
                                        <CardContent>
                                          {lineItems.length === 0 ? (
                                            <p className="text-muted-foreground">No line items found</p>
                                          ) : (
                                            <Table>
                                              <TableHeader>
                                                <TableRow>
                                                  <TableHead>Date</TableHead>
                                                  <TableHead>Category</TableHead>
                                                  <TableHead>Description</TableHead>
                                                  <TableHead className="text-right">Amount</TableHead>
                                                </TableRow>
                                              </TableHeader>
                                              <TableBody>
                                                {lineItems.map((item) => (
                                                  <TableRow key={item.id}>
                                                    <TableCell>
                                                      {format(new Date(item.date), "MMM d, yyyy")}
                                                    </TableCell>
                                                    <TableCell>
                                                      <Badge variant="outline" className="capitalize">
                                                        {item.category}
                                                      </Badge>
                                                    </TableCell>
                                                    <TableCell>{item.description}</TableCell>
                                                    <TableCell className="text-right">
                                                      {formatINR(item.amount)}
                                                    </TableCell>
                                                  </TableRow>
                                                ))}
                                              </TableBody>
                                            </Table>
                                          )}
                                        </CardContent>
                                      </Card>

                                      {/* Attachments */}
                                      {attachments.length > 0 && (
                                        <Card>
                                          <CardHeader className="pb-3">
                                            <CardTitle className="text-base">Receipts & Attachments</CardTitle>
                                          </CardHeader>
                                          <CardContent>
                                            <div className="space-y-2">
                                              {attachments.map((attachment) => (
                                                <div
                                                  key={attachment.id}
                                                  className="flex items-center justify-between p-3 border rounded-lg"
                                                >
                                                  <div className="flex items-center gap-3">
                                                    <FileText className="h-4 w-4 text-muted-foreground" />
                                                    <div>
                                                      <p className="font-medium text-sm">{attachment.filename}</p>
                                                      <p className="text-xs text-muted-foreground">
                                                        {attachment.content_type} • {format(new Date(attachment.created_at), "MMM d, yyyy")}
                                                      </p>
                                                    </div>
                                                  </div>
                                                  <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                      setImagePreviewUrl(attachment.file_url);
                                                      setPreviewContentType(attachment.content_type);
                                                      setPreviewUploadedBy(selectedExpense?.user_id ?? null);
                                                      setImagePreviewOpen(true);
                                                    }}
                                                  >
                                                    View
                                                  </Button>
                                                </div>
                                              ))}
                                            </div>
                                          </CardContent>
                                        </Card>
                                      )}

                                      {/* Admin Comments */}
                                      {selectedExpense.admin_comment && (
                                        <Card>
                                          <CardHeader className="pb-3">
                                            <CardTitle className="text-base">Admin Comments</CardTitle>
                                          </CardHeader>
                                          <CardContent>
                                            <p className="text-sm">{selectedExpense.admin_comment}</p>
                                          </CardContent>
                                        </Card>
                                      )}

                                      <Card>
                                        <CardHeader className="pb-3">
                                          <CardTitle className="text-base">
                                            {t("admin:review.timeline.title", { defaultValue: "Review timeline" })}
                                          </CardTitle>
                                          <CardDescription className="text-xs">
                                            {t("admin:review.timeline.activity", {
                                              defaultValue: "Workflow progress and every action on this expense",
                                            })}
                                          </CardDescription>
                                        </CardHeader>
                                        <CardContent>
                                          <ExpenseReviewTimeline
                                            expense={{
                                              status: selectedExpense.status,
                                              total_amount: selectedExpense.total_amount,
                                              approval_tier: selectedExpense.approval_tier,
                                              assigned_reviewer_id: selectedExpense.assigned_reviewer_id,
                                              assigned_engineer_id: selectedExpense.assigned_engineer_id,
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
                                            managerApprovalLimit={engineerApprovalLimit}
                                          />
                                        </CardContent>
                                      </Card>

                                      {correctionLogs.length > 0 && (
                                        <Card>
                                          <CardHeader className="pb-3">
                                            <CardTitle className="text-base">Reviewer corrections (detail)</CardTitle>
                                          </CardHeader>
                                          <CardContent>
                                            <ExpenseCorrectionAuditList logs={correctionLogs} maxHeightClassName="max-h-72" />
                                          </CardContent>
                                        </Card>
                                      )}

                                      {/* Manager Review */}
                                      <Card>
                                        <CardHeader className="pb-3">
                                          <CardTitle className="text-base">Manager Review</CardTitle>
                                        </CardHeader>
                                        <CardContent className="space-y-4">
                                          <div>
                                            <label className="text-sm font-medium">Review Comment</label>
                                            <Textarea
                                              value={engineerComment}
                                              onChange={(e) => setEngineerComment(e.target.value)}
                                              placeholder="Add your review comments..."
                                              className="mt-1"
                                            />
                                          </div>
                                        </CardContent>
                                      </Card>
                                    </div>
                                  )}

                                  <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-0">
                                    <Button
                                      variant="outline"
                                      onClick={() => {
                                        setSelectedExpense(null);
                                        setEngineerComment("");
                                        setLineItems([]);
                                        setAttachments([]);
                                        setAuditLogs([]);
                                        setCorrectionLogs([]);
                                        setTimelineAssignees({});
                                      }}
                                      className="w-full sm:w-auto"
                                    >
                                      Cancel
                                    </Button>
                                    {canEngineerCorrectExpense(selectedExpense) ? (
                                      <Button type="button" variant="secondary" className="w-full sm:w-auto" onClick={openCorrectionDialog}>
                                        Correct expense
                                      </Button>
                                    ) : null}
                                    {selectedExpense && (() => {
                                      // Don't show any action buttons for rejected expenses (unless correct-only handled above)
                                      if (selectedExpense.status === "rejected") {
                                        return null;
                                      }

                                      const expenseAmount = Number(selectedExpense.total_amount);
                                      const limit = Number(engineerApprovalLimit);
                                      const canTakeAction = !isActionDisabled(selectedExpense);

                                      if (!canApprove) {
                                        if (!canTakeAction) {
                                          return null;
                                        }
                                        return (
                                          <>
                                            <Button
                                              onClick={() => rejectExpense()}
                                              disabled={reviewLoading}
                                              variant="destructive"
                                              className="w-full sm:w-auto"
                                            >
                                              Reject
                                            </Button>
                                            <Button
                                              onClick={() => verifyExpense()}
                                              disabled={reviewLoading}
                                              className="bg-blue-500 hover:bg-blue-600 w-full sm:w-auto"
                                            >
                                              Verify
                                            </Button>
                                          </>
                                        );
                                      }

                                      if (expenseAmount <= limit) {
                                        return (
                                          <>
                                            <Button
                                              onClick={() => rejectExpense()}
                                              disabled={reviewLoading || !canTakeAction}
                                              variant="destructive"
                                              className="w-full sm:w-auto"
                                            >
                                              Reject
                                            </Button>
                                            <Button
                                              onClick={() => approveExpense()}
                                              disabled={reviewLoading || !canTakeAction}
                                              className="w-full sm:w-auto"
                                            >
                                              Approve
                                            </Button>
                                          </>
                                        );
                                      } else {
                                        return (
                                          <>
                                            <Button
                                              onClick={() => rejectExpense()}
                                              disabled={reviewLoading || !canTakeAction}
                                              variant="destructive"
                                              className="w-full sm:w-auto"
                                            >
                                              Reject
                                            </Button>
                                            <Button
                                              onClick={() => verifyExpense()}
                                              disabled={reviewLoading || !canTakeAction}
                                              className="bg-blue-500 hover:bg-blue-600 w-full sm:w-auto"
                                            >
                                              Verify
                                            </Button>
                                          </>
                                        );
                                      }
                                    })()}
                                  </DialogFooter>
                                </DialogContent>
                              </Dialog>
                            )}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Pagination controls */}
          {expenses.length > 0 && (
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between text-sm">
              <p className="text-muted-foreground">
                {/* SERVER-QUERY mode: the range is anchored to the server page and
                    the total is the server-reported filtered total (§27). NORMAL
                    mode: range within the loaded client slice. */}
                Showing{" "}
                {reviewFilterActive
                  ? `${(safeCurrentPage - 1) * REVIEW_PAGE_SIZE + 1}–${(safeCurrentPage - 1) * REVIEW_PAGE_SIZE + expenses.length} of ${totalAvailable ?? expenses.length}`
                  : `${expenses.length === 0 ? 0 : pageStartIndex + 1}–${Math.min(pageStartIndex + REVIEW_PAGE_SIZE, expenses.length)} of ${expenses.length}`}{" "}
                expenses
                {!reviewFilterActive && !allExpensesLoaded && (
                  <span className="ml-1 text-xs">
                    {/* Never present a partial count as the database total. */}
                    {totalAvailable !== null
                      ? `(loaded ${allExpenses.length} of ${totalAvailable})`
                      : `(${allExpenses.length}+ loaded)`}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => {
                    if (reviewFilterActive) goServerPage(safeCurrentPage - 1);
                    else setCurrentPage((p) => Math.max(1, p - 1));
                    setSelectedKeys(new Set());
                  }}
                  disabled={safeCurrentPage <= 1}
                >
                  ‹ Prev
                </Button>
                {getVisiblePageNumbers().map((page, idx) =>
                  page === "…" ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground">…</span>
                  ) : (
                    <Button
                      key={page}
                      variant={safeCurrentPage === page ? "default" : "outline"}
                      size="sm"
                      className="h-8 w-8 p-0 text-xs"
                      onClick={() => {
                        if (reviewFilterActive) goServerPage(page as number);
                        else setCurrentPage(page as number);
                        setSelectedKeys(new Set());
                      }}
                    >
                      {page}
                    </Button>
                  )
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-xs"
                  onClick={() => {
                    if (reviewFilterActive) goServerPage(safeCurrentPage + 1);
                    else setCurrentPage((p) => Math.min(totalPages, p + 1));
                    setSelectedKeys(new Set());
                  }}
                  disabled={safeCurrentPage >= totalPages}
                >
                  Next ›
                </Button>
              </div>
              <div className="flex flex-col gap-2">
                {loadAllProgress.status !== "idle" && (
                  <AsyncOperationProgress
                    status={loadAllProgress.status}
                    title={loadAllProgress.phase}
                    showSuccess={loadAllProgress.status === "success"}
                  />
                )}
                {/* Partial failure: rows stay visible, and we never claim completeness. */}
                {loadError && (
                  <div className="flex flex-col gap-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    <span>
                      Loaded {allExpenses.length}
                      {totalAvailable !== null ? ` of ${totalAvailable}` : ""} expenses. Some
                      could not be loaded.
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={handleRetryRemaining}
                        disabled={loadingAllExpenses}
                      >
                        Retry remaining
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setLoadError(null)}
                      >
                        Keep current results
                      </Button>
                    </div>
                  </div>
                )}
                {identityDegraded && (
                  <span className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    Some employee names could not be loaded. Rows are still shown;
                    refresh to try again.
                  </span>
                )}
                {enrichmentDegraded && (
                  <span className="text-xs text-muted-foreground">
                    Some optional details could not be loaded.
                  </span>
                )}
                {customFieldFilterIncomplete && (
                  <span className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                    Custom-field filters only search expenses whose details are
                    loaded. Use “Load all older expenses” for a complete result.
                  </span>
                )}
                {/* Compatibility mode: state the limitation in plain language;
                    the raw RPC error stays in state and the console. */}
                {paginationMode === "legacy" && (
                  <span className="text-xs text-muted-foreground">
                    Using compatibility loading because the latest database
                    pagination functions are not installed.
                  </span>
                )}
                {!allExpensesLoaded && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs whitespace-nowrap"
                    onClick={() => void handleLoadAllExpenses()}
                    disabled={loadingAllExpenses}
                  >
                    {loadingAllExpenses
                      ? totalAvailable !== null
                        ? `Loading ${allExpenses.length} of ${totalAvailable}…`
                        : `Loading ${allExpenses.length}+ …`
                      : loadError
                        ? "Retry remaining"
                        : "Load all older expenses"}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={correctionDialogOpen} onOpenChange={setCorrectionDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Correct expense (on behalf of employee)</DialogTitle>
            <DialogDescription>
              Saves an audit record and sets status to adjusted. The employee still sees this expense as in review.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="eng-corr-title">{getBaseFieldLabel("title")}</Label>
              <Input id="eng-corr-title" value={corrTitle} onChange={(e) => setCorrTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="eng-corr-dest">{getBaseFieldLabel("destination")}</Label>
              <Input id="eng-corr-dest" value={corrDestination} onChange={(e) => setCorrDestination(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="eng-corr-date">{getBaseFieldLabel("expense_date")}</Label>
              <Input id="eng-corr-date" type="date" value={corrExpenseDate} onChange={(e) => setCorrExpenseDate(e.target.value)} />
              <p className="text-xs text-muted-foreground mt-1">
                Same as the employee expense form — one date is stored for this expense.
              </p>
            </div>
            <div>
              <Label htmlFor="eng-corr-pur">{getBaseFieldLabel("purpose")}</Label>
              <Textarea id="eng-corr-pur" value={corrPurpose} onChange={(e) => setCorrPurpose(e.target.value)} rows={2} />
            </div>
            <div>
              <Label htmlFor="eng-corr-cat">{getBaseFieldLabel("category")}</Label>
              <ExpenseCategorySelect
                id="eng-corr-cat"
                organizationId={organizationId}
                value={corrCategory}
                onChange={setCorrCategory}
              />
            </div>
            <div>
              <Label htmlFor="eng-corr-amt">{getBaseFieldLabel("amount")}</Label>
              <Input id="eng-corr-amt" type="number" min={0} step="0.01" value={corrAmount} onChange={(e) => setCorrAmount(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="eng-corr-ac">Admin comment</Label>
              <Textarea id="eng-corr-ac" value={corrAdminComment} onChange={(e) => setCorrAdminComment(e.target.value)} rows={2} />
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
              userId={user?.id}
              onSelectOptionValue={handleCorrectionSelectOptionValue}
            />
            <div>
              <Label htmlFor="eng-corr-reason">Reason for correction (audit)</Label>
              <Textarea id="eng-corr-reason" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} rows={2} />
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

      <AttachmentPreviewDialog
        open={imagePreviewOpen}
        onOpenChange={setImagePreviewOpen}
        url={imagePreviewUrl}
        contentType={previewContentType}
        uploadedBy={previewUploadedBy}
        expenseId={selectedExpense?.id ?? null}
      />
      {approvalWarningDialog}
    </div>
  );
}
