import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useTranslation } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import {
  resolveBaseFieldConfig,
  DEFAULT_BASE_FIELD_CONFIG,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";
import { ExpenseService } from "@/services/ExpenseService";
import { useToast } from "@/hooks/use-toast";
import { formatINR, parseLocalDate } from "@/lib/format";
import { format } from "date-fns";
import {
  batchReviewActionLabel,
  expensesEligibleForBatchAction,
  fetchBatchExpenseCustomFields,
  type BatchReviewAction,
  type BatchReviewExpenseRow,
  type BatchReviewRole,
} from "@/lib/batchExpenseReview";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExpenseStatusWithCorrectionBadge } from "@/components/ExpenseStatusWithCorrectionBadge";
import { BatchExpenseDetailCard } from "@/components/BatchExpenseDetailCard";
import { Loader2, Eye, Layers, AlertCircle } from "lucide-react";
import { useResizableColumns, resizeHandleClass } from "@/hooks/useResizableColumns";
import { cn } from "@/lib/utils";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileBatchReviewView } from "@/components/mobile/MobileBatchReviewView";
import { MobileBatchLineDetail } from "@/components/mobile/MobileBatchLineDetail";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import {
  loadCorrectionCustomFields,
  validateCorrectionCustomFields,
  type CorrectionCustomFieldsModel,
  EMPTY_CORRECTION_FIELDS,
} from "@/lib/loadCorrectionCustomFields";
import { CorrectionCustomFieldsSection } from "@/components/CorrectionCustomFieldsSection";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";

export interface BatchExpenseReviewBatchInfo {
  id: string;
  label: string | null;
  shared_category: string;
  shared_expense_date: string;
  line_count: number;
  total_amount: number;
  created_at: string;
  user_id: string;
}

interface BatchExpenseReviewPanelProps {
  batchId: string;
  organizationId: string;
  userId: string;
  role: BatchReviewRole;
  engineerApprovalLimit?: number;
  highlightExpenseId?: string | null;
  onReviewComplete?: () => void;
}

export function BatchExpenseReviewPanel({
  batchId,
  organizationId,
  userId,
  role,
  engineerApprovalLimit = 50000,
  highlightExpenseId,
  onReviewComplete,
}: BatchExpenseReviewPanelProps) {
  const { toast } = useToast();
  const { t, i18n } = useTranslation(["expenses", "common"]);
  const { isMobile } = useViewportMode();
  const { organizationFeatureFlags } = useAuth();
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;
  const highlightExpenseIdRef = useRef(highlightExpenseId);
  highlightExpenseIdRef.current = highlightExpenseId;
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<BatchReviewAction | null>(null);
  const [batch, setBatch] = useState<BatchExpenseReviewBatchInfo | null>(null);
  const [expenses, setExpenses] = useState<BatchReviewExpenseRow[]>([]);
  const [submitterName, setSubmitterName] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reviewComment, setReviewComment] = useState("");
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [customFieldColumns, setCustomFieldColumns] = useState<string[]>([]);
  const [correctionDialogOpen, setCorrectionDialogOpen] = useState(false);
  const [correctionLoading, setCorrectionLoading] = useState(false);
  const [corrTitle, setCorrTitle] = useState("");
  const [corrDestination, setCorrDestination] = useState("");
  const [corrExpenseDate, setCorrExpenseDate] = useState("");
  const [corrPurpose, setCorrPurpose] = useState("");
  const [corrCategory, setCorrCategory] = useState("");
  const [corrAmount, setCorrAmount] = useState("");
  const [corrReason, setCorrReason] = useState("");
  const [corrFieldModel, setCorrFieldModel] = useState<CorrectionCustomFieldsModel>(EMPTY_CORRECTION_FIELDS);
  const [baseFieldConfig, setBaseFieldConfig] =
    useState<Record<BaseExpenseFieldKey, BaseFieldConfig>>(DEFAULT_BASE_FIELD_CONFIG);
  const {
    progress: loadProgress,
    startOperation: startLoadProgress,
    completeOperation: completeLoadProgress,
  } = useOperationProgress();
  const {
    progress: actionProgress,
    startOperation: startActionProgress,
    completeOperation: completeActionProgress,
    failOperation: failActionProgress,
  } = useOperationProgress();
  const prevLoadingRef = useRef(false);
  const prevActionLoadingRef = useRef<BatchReviewAction | null>(null);
  // Cancels the previous load's custom-field fetch when batch/org changes or the panel
  // unmounts, so a slow superseded request can never overwrite fresher state.
  const customFieldsAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;
    if (loading && !wasLoading) {
      startLoadProgress(t("batchReview.loading", { defaultValue: "Loading batch…" }));
    } else if (!loading && wasLoading) {
      completeLoadProgress(t("batchReview.loaded", { defaultValue: "Batch loaded" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  useEffect(() => {
    const wasAction = prevActionLoadingRef.current;
    prevActionLoadingRef.current = actionLoading;
    if (actionLoading && !wasAction) {
      const verb = actionLoading === "verify" ? "Verifying" : actionLoading === "approve" ? "Approving" : "Rejecting";
      startActionProgress(`${verb} expenses…`);
    } else if (!actionLoading && wasAction) {
      const verb = wasAction === "verify" ? "Verified" : wasAction === "approve" ? "Approved" : "Rejected";
      completeActionProgress(`${verb} successfully`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionLoading]);

  const translatedBaseFields = useMemo(
    () => translateBaseFieldConfig(baseFieldConfig, t),
    [baseFieldConfig, t, i18n.language],
  );
  const getBaseField = (key: BaseExpenseFieldKey): BaseFieldConfig =>
    translatedBaseFields[key] ?? translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, t)[key];

  const loadBatch = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: fields }, { data: batchRow, error: batchError }] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("organization_expense_form_fields")
          .select("*")
          .eq("organization_id", organizationId),
        supabase
          .from("expense_batches")
          .select(
            "id, label, shared_category, shared_expense_date, line_count, total_amount, created_at, user_id",
          )
          .eq("id", batchId)
          .eq("organization_id", organizationId)
          .maybeSingle(),
      ] as const);

      if (fields) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setBaseFieldConfig(resolveBaseFieldConfig(fields as any));
      }

      if (batchError) throw batchError;

      // expense_batches SELECT RLS historically missed assigned_reviewer_id, so managers
      // (team_leader / executive) get null even when assigned. Fall back to the expenses
      // table which has correct hierarchy-reviewer RLS since 20260524.
      let resolvedBatch: BatchExpenseReviewBatchInfo | null = null;

      if (batchRow) {
        resolvedBatch = {
          id: batchRow.id as string,
          label: batchRow.label as string | null,
          shared_category: batchRow.shared_category as string,
          shared_expense_date: batchRow.shared_expense_date as string,
          line_count: Number(batchRow.line_count),
          total_amount: Number(batchRow.total_amount),
          created_at: batchRow.created_at as string,
          user_id: batchRow.user_id as string,
        };
      } else {
        const { data: expFallback } = await supabase
          .from("expenses")
          .select("category, trip_start, user_id, total_amount")
          .eq("batch_id", batchId)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true });

        if (expFallback && expFallback.length > 0) {
          resolvedBatch = {
            id: batchId,
            label: null,
            shared_category: (expFallback[0].category as string | null) ?? "Other",
            shared_expense_date:
              (expFallback[0].trip_start as string | null) ?? new Date().toISOString().slice(0, 10),
            line_count: expFallback.length,
            total_amount: expFallback.reduce((s, e) => s + Number(e.total_amount), 0),
            created_at: new Date().toISOString(),
            user_id: (expFallback[0].user_id as string | null) ?? "",
          };
        }
      }

      if (!resolvedBatch) {
        setBatch(null);
        setExpenses([]);
        return;
      }

      setBatch(resolvedBatch);

      const { data: profile } = await supabase
        .from("profiles")
        .select("name")
        .eq("organization_id", organizationId)
        .eq("user_id", resolvedBatch.user_id)
        .maybeSingle();
      setSubmitterName((profile?.name as string) || "Employee");

      const { data: expenseRows, error: expError } = await supabase
        .from("expenses")
        .select(
          "id, title, category, purpose, destination, trip_start, total_amount, status, transaction_number, user_id",
        )
        .eq("batch_id", batchId)
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true });

      if (expError) throw expError;

      const userIds = [...new Set((expenseRows || []).map((e) => e.user_id))];
      const expenseIds = (expenseRows || []).map((e) => e.id);

      customFieldsAbortRef.current?.abort();
      const cfController = new AbortController();
      customFieldsAbortRef.current = cfController;

      const [{ data: profiles }, correctedIds, cfResult] = await Promise.all([
        supabase
          .from("profiles")
          .select("user_id, name, email")
          .eq("organization_id", organizationId)
          .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]),
        expenseIds.length > 0
          ? ExpenseService.getExpenseIdsWithReviewerCorrections(expenseIds, organizationId)
          : Promise.resolve(new Set<string>()),
        fetchBatchExpenseCustomFields(expenseIds, organizationId, batchId, cfController.signal),
      ]);

      if (cfResult.status === "aborted") return;

      if (cfResult.status === "error") {
        setCustomFieldColumns([]);
        toastRef.current({
          variant: "destructive",
          title: tRef.current("common:error"),
          description: tRef.current("batchReview.customFieldsLoadFailed", {
            defaultValue: "Some custom field values could not be loaded. Values shown below may be incomplete.",
          }),
        });
      } else {
        setCustomFieldColumns(cfResult.columns);
      }

      const cfValuesByExpenseId =
        cfResult.status === "ok" ? cfResult.valuesByExpenseId : new Map<string, Record<string, string>>();

      const mapped: BatchReviewExpenseRow[] = (expenseRows || []).map((e) => {
        const profile = profiles?.find((p) => p.user_id === e.user_id);
        return {
          id: e.id,
          title: e.title,
          category: e.category,
          purpose: e.purpose,
          destination: e.destination,
          trip_start: e.trip_start,
          total_amount: Number(e.total_amount),
          status: e.status,
          transaction_number: e.transaction_number,
          user_id: e.user_id,
          user_name: profile?.name || "Unknown",
          user_email: profile?.email || "",
          wasReviewerCorrected: correctedIds.has(e.id),
          customFields: cfValuesByExpenseId.get(e.id) ?? {},
        };
      });

      setExpenses(mapped);
      setSelectedIds(new Set(mapped.map((e) => e.id)));

      if (!isMobileRef.current && highlightExpenseIdRef.current && mapped.some((e) => e.id === highlightExpenseIdRef.current)) {
        setOpenDetailId(highlightExpenseIdRef.current);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : tRef.current("batchReview.loadFailed");
      toastRef.current({ variant: "destructive", title: tRef.current("common:error"), description: message });
    } finally {
      setLoading(false);
    }
  }, [batchId, organizationId]);

  useEffect(() => {
    loadBatch();
    return () => {
      customFieldsAbortRef.current?.abort();
    };
  }, [loadBatch]);

  const selectedExpenses = useMemo(
    () => expenses.filter((e) => selectedIds.has(e.id)),
    [expenses, selectedIds],
  );

  const eligible = useCallback(
    (action: BatchReviewAction) =>
      expensesEligibleForBatchAction(
        selectedExpenses,
        action,
        role,
        engineerApprovalLimit,
      ),
    [selectedExpenses, role, engineerApprovalLimit],
  );

  const batchColDefaults = useMemo(
    () => ({
      title: 160,
      category: 130,
      purpose: 190,
      amount: 110,
      status: 130,
      ...Object.fromEntries(customFieldColumns.map((col) => [col, 150])),
    }),
    [customFieldColumns],
  );
  const { colWidth, startResize } = useResizableColumns("pw_batch_review_cols", batchColDefaults);

  const runBatchAction = async (action: BatchReviewAction) => {
    const targets = eligible(action);
    if (targets.length === 0) {
      toast({
        variant: "destructive",
        title: t("batchReview.noEligible"),
        description: t("batchReview.noEligibleDescription", {
          action:
            action === "verify"
              ? t("batchReview.actionVerify")
              : action === "approve"
                ? t("batchReview.actionApprove")
                : t("batchReview.actionReject"),
        }),
      });
      return;
    }

    setActionLoading(action);
    try {
      const { results, successCount, failureCount } = await ExpenseService.processBatchReview(
        targets.map((e) => e.id),
        userId,
        action,
        reviewComment.trim() || undefined,
        role,
      );

      if (successCount > 0) {
        toast({
          title: t("batchReview.complete"),
          description: t("batchReview.completeDescription", {
            success: successCount,
            failures:
              failureCount > 0
                ? t("batchReview.failuresSuffix", { count: failureCount })
                : "",
          }),
        });
      }
      if (failureCount > 0 && successCount === 0) {
        toast({
          variant: "destructive",
          title: t("batchReview.failed"),
          description: results.find((r) => !r.ok)?.error || t("batchReview.allFailed"),
        });
      }

      await loadBatch();
      onReviewComplete?.();
    } finally {
      setActionLoading(null);
    }
  };

  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(expenses.map((e) => e.id)) : new Set());
  };

  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <AsyncOperationProgress
          status={loadProgress.status !== "idle" ? loadProgress.status : "running"}
          title={loadProgress.phase || t("batchReview.loading")}
        />
      </div>
    );
  }

  if (!batch) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          {t("batchReview.notFound")}
        </CardContent>
      </Card>
    );
  }

  const verifyCount = eligible("verify").length;
  const approveCount = eligible("approve").length;
  const rejectCount = eligible("reject").length;
  const openDetailExpense = openDetailId
    ? expenses.find((e) => e.id === openDetailId) ?? null
    : null;
  const selectedSingleExpense = selectedExpenses.length === 1 ? selectedExpenses[0] : null;

  const openCorrectionDialog = async () => {
    if (!selectedSingleExpense) return;
    setCorrTitle(selectedSingleExpense.title || "");
    setCorrDestination(selectedSingleExpense.destination || "");
    setCorrExpenseDate(String(selectedSingleExpense.trip_start || "").slice(0, 10));
    setCorrPurpose(selectedSingleExpense.purpose || "");
    setCorrCategory(selectedSingleExpense.category || "");
    setCorrAmount(String(selectedSingleExpense.total_amount ?? ""));
    setCorrReason("");
    setCorrFieldModel({ ...EMPTY_CORRECTION_FIELDS });
    if (selectedSingleExpense.category) {
      const model = await loadCorrectionCustomFields(
        supabase,
        organizationId,
        selectedSingleExpense.id,
        selectedSingleExpense.category,
      );
      setCorrFieldModel(model);
    }
    setCorrectionDialogOpen(true);
  };

  const openCorrectionDialogForExpense = async (expense: BatchReviewExpenseRow) => {
    setSelectedIds(new Set([expense.id]));
    setCorrTitle(expense.title || "");
    setCorrDestination(expense.destination || "");
    setCorrExpenseDate(String(expense.trip_start || "").slice(0, 10));
    setCorrPurpose(expense.purpose || "");
    setCorrCategory(expense.category || "");
    setCorrAmount(String(expense.total_amount ?? ""));
    setCorrReason("");
    setCorrFieldModel({ ...EMPTY_CORRECTION_FIELDS });
    if (expense.category) {
      const model = await loadCorrectionCustomFields(
        supabase,
        organizationId,
        expense.id,
        expense.category,
      );
      setCorrFieldModel(model);
    }
    setCorrectionDialogOpen(true);
  };

  const submitCorrection = async () => {
    if (!selectedSingleExpense) return;
    const amount = Number(corrAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: "Amount must be a positive number.",
      });
      return;
    }

    const vResult = validateCorrectionCustomFields(
      corrFieldModel.categoryFormFields,
      corrFieldModel.formFieldValues,
      corrFieldModel.optionBranches,
      corrFieldModel.branchValues,
      allowNestedConditional,
    );
    if (!vResult.ok) {
      toast({ variant: "destructive", title: t("common:error"), description: vResult.message });
      return;
    }

    const visibleBranchIds = getVisibleBranchIds(
      corrFieldModel.optionBranches,
      corrFieldModel.formFieldValues,
      corrFieldModel.branchValues,
      allowNestedConditional,
    );

    setCorrectionLoading(true);
    try {
      await ExpenseService.applyExpenseCorrectionByReviewer(
        selectedSingleExpense.id,
        userId,
        {
          title: corrTitle.trim(),
          destination: corrDestination.trim(),
          trip_start: corrExpenseDate,
          trip_end: corrExpenseDate,
          purpose: corrPurpose.trim() || null,
          category: corrCategory.trim() || null,
          total_amount: amount,
        },
        corrReason.trim() || null,
        corrFieldModel.categoryFormFields.length > 0 ? corrFieldModel.formFieldValues : undefined,
        corrFieldModel.categoryFormFields.length > 0 ? corrFieldModel.branchValues : undefined,
        corrFieldModel.categoryFormFields.length > 0 ? visibleBranchIds : undefined,
      );
      toast({
        title: "Expense corrected",
        description: "Selected batch expense has been updated.",
      });
      setCorrectionDialogOpen(false);
      await loadBatch();
      onReviewComplete?.();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to correct expense";
      toast({ variant: "destructive", title: t("common:error"), description: message });
    } finally {
      setCorrectionLoading(false);
    }
  };

  // Mobile: full-screen line detail
  if (isMobile && openDetailId) {
    const detailExp = expenses.find((e) => e.id === openDetailId);
    if (detailExp) {
      return (
        <MobileBatchLineDetail
          expense={detailExp}
          organizationId={organizationId}
          role={role}
          actionLoading={actionLoading}
          canVerify={eligible("verify").length > 0}
          canApprove={eligible("approve").length > 0}
          canReject={eligible("reject").length > 0}
          correctionDialogOpen={correctionDialogOpen}
          correctionLoading={correctionLoading}
          corrTitle={corrTitle}
          setCorrTitle={setCorrTitle}
          corrDestination={corrDestination}
          setCorrDestination={setCorrDestination}
          corrExpenseDate={corrExpenseDate}
          setCorrExpenseDate={setCorrExpenseDate}
          corrPurpose={corrPurpose}
          setCorrPurpose={setCorrPurpose}
          corrCategory={corrCategory}
          setCorrCategory={setCorrCategory}
          corrAmount={corrAmount}
          setCorrAmount={setCorrAmount}
          corrReason={corrReason}
          setCorrReason={setCorrReason}
          reviewComment={reviewComment}
          setReviewComment={setReviewComment}
          titleLabel={getBaseField("title").label}
          destinationLabel={getBaseField("destination").label}
          purposeLabel={getBaseField("purpose").label}
          categoryLabel={getBaseField("category").label}
          amountLabel={getBaseField("amount").label}
          onBack={() => {
            setOpenDetailId(null);
            setSelectedIds(new Set());
            setCorrectionDialogOpen(false);
          }}
          onVerify={() => void runBatchAction("verify")}
          onApprove={() => void runBatchAction("approve")}
          onReject={() => void runBatchAction("reject")}
          onCorrect={() => openCorrectionDialogForExpense(detailExp)}
          onSubmitCorrection={() => void submitCorrection()}
          onCancelCorrection={() => setCorrectionDialogOpen(false)}
        />
      );
    }
  }

  // Mobile: card-based line list
  if (isMobile) {
    return (
      <MobileBatchReviewView
        batch={batch}
        expenses={expenses}
        submitterName={submitterName}
        role={role}
        onSelectExpense={(exp) => {
          setSelectedIds(new Set([exp.id]));
          setOpenDetailId(exp.id);
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Layers className="h-5 w-5 text-blue-700" />
            {t("batchReview.title")}
          </CardTitle>
          <CardDescription>
            {batch.label ? `${batch.label} · ` : ""}
            {format(parseLocalDate(batch.shared_expense_date), "MMM d, yyyy")} ·{" "}
            {batch.shared_category} · {submitterName}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-6 text-sm">
          <div>
            <span className="text-muted-foreground">{t("batchReview.lines")}</span>
            <p className="font-semibold">{expenses.length}</p>
          </div>
          <div>
            <span className="text-muted-foreground">{t("batchReview.batchTotal")}</span>
            <p className="font-semibold">{formatINR(batch.total_amount)}</p>
          </div>
          <div>
            <span className="text-muted-foreground">{t("batchReview.submitted")}</span>
            <p className="font-semibold">
              {format(new Date(batch.created_at), "MMM d, yyyy h:mm a")}
            </p>
          </div>
          {role === "engineer" && (
            <div>
              <span className="text-muted-foreground">{t("batchReview.approvalLimit")}</span>
              <p className="font-semibold">
                {Number.isFinite(engineerApprovalLimit) ? formatINR(engineerApprovalLimit) : "No limit"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">{t("batchReview.consolidatedTitle")}</CardTitle>
          <CardDescription>
            {t("batchReview.consolidatedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          <div data-testid="batch-review-scroll-container" className="relative w-full overflow-x-auto">
            <Table noScrollWrapper className="min-w-max">
              <TableHeader>
                <TableRow>
                  {role !== "employee" && (
                    <TableHead className="w-10">
                      <Checkbox
                        checked={expenses.length > 0 && selectedIds.size === expenses.length}
                        onCheckedChange={(v) => toggleAll(v === true)}
                        aria-label={t("batchReview.selectAll")}
                      />
                    </TableHead>
                  )}
                  <TableHead className="relative group/th overflow-hidden" style={{ width: colWidth("title"), minWidth: colWidth("title") }}>
                    {getBaseField("title").label}
                    <div className={resizeHandleClass} onMouseDown={(e) => startResize("title", e)} />
                  </TableHead>
                  <TableHead className="relative group/th overflow-hidden" style={{ width: colWidth("category"), minWidth: colWidth("category") }}>
                    {getBaseField("category").label}
                    <div className={resizeHandleClass} onMouseDown={(e) => startResize("category", e)} />
                  </TableHead>
                  <TableHead className="relative group/th overflow-hidden hidden md:table-cell" style={{ width: colWidth("purpose"), minWidth: colWidth("purpose") }}>
                    {getBaseField("purpose").label}
                    <div className={resizeHandleClass} onMouseDown={(e) => startResize("purpose", e)} />
                  </TableHead>
                  {customFieldColumns.map((col) => (
                    <TableHead key={col} className="relative group/th overflow-hidden hidden md:table-cell" style={{ width: colWidth(col), minWidth: colWidth(col) }}>
                      {col}
                      <div className={resizeHandleClass} onMouseDown={(e) => startResize(col, e)} />
                    </TableHead>
                  ))}
                  <TableHead className="relative group/th overflow-hidden" style={{ width: colWidth("amount"), minWidth: colWidth("amount") }}>
                    {getBaseField("amount").label}
                    <div className={resizeHandleClass} onMouseDown={(e) => startResize("amount", e)} />
                  </TableHead>
                  <TableHead className="relative group/th overflow-hidden" style={{ width: colWidth("status"), minWidth: colWidth("status") }}>
                    {t("batchReview.tableStatus")}
                    <div className={resizeHandleClass} onMouseDown={(e) => startResize("status", e)} />
                  </TableHead>
                  <TableHead data-testid="batch-review-actions-header" className="sticky right-0 z-30 min-w-[140px] border-l bg-background shadow-[-4px_0_8px_-6px_rgba(0,0,0,0.25)] text-right">{t("batchReview.tableDetail")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {expenses.map((exp) => (
                  <TableRow
                    key={exp.id}
                    className={cn(
                      "group",
                      openDetailId === exp.id && "bg-blue-50/80",
                      highlightExpenseId === exp.id && openDetailId !== exp.id && "bg-amber-50/50",
                    )}
                  >
                    {role !== "employee" && (
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(exp.id)}
                          onCheckedChange={(v) => toggleOne(exp.id, v === true)}
                          aria-label={`Select ${exp.title}`}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="font-medium">{exp.title}</div>
                      {exp.transaction_number && (
                        <p className="text-xs font-mono text-muted-foreground">
                          #{exp.transaction_number}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{exp.category || "—"}</TableCell>
                    <TableCell className="hidden md:table-cell max-w-[200px] truncate text-sm text-muted-foreground">
                      {exp.purpose || "—"}
                    </TableCell>
                    {customFieldColumns.map((col) => (
                      <TableCell key={col} className="hidden md:table-cell text-sm text-muted-foreground truncate max-w-[150px]">
                        {exp.customFields?.[col] ?? "—"}
                      </TableCell>
                    ))}
                    <TableCell className="font-medium whitespace-nowrap">
                      {formatINR(exp.total_amount)}
                    </TableCell>
                    <TableCell>
                      <ExpenseStatusWithCorrectionBadge
                        status={exp.status}
                        wasReviewerCorrected={exp.wasReviewerCorrected}
                        viewerContext="reviewer"
                      />
                    </TableCell>
                    <TableCell data-testid="batch-review-actions-cell" className="sticky right-0 z-20 min-w-[140px] border-l bg-background group-hover:bg-muted text-right">
                      <div className="flex justify-end gap-2">
                        {role !== "employee" && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openCorrectionDialogForExpense(exp)}
                          >
                            Edit
                          </Button>
                        )}
                        <Button
                          variant={openDetailId === exp.id ? "secondary" : "ghost"}
                          size="sm"
                          onClick={() =>
                            setOpenDetailId((current) => (current === exp.id ? null : exp.id))
                          }
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          {openDetailId === exp.id ? t("batchReview.close") : t("batchReview.open")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {openDetailExpense && (
        <BatchExpenseDetailCard
          expense={openDetailExpense}
          organizationId={organizationId}
          categoryLabel={getBaseField("category").label}
          purposeLabel={getBaseField("purpose").label}
          amountLabel={getBaseField("amount").label}
          destinationLabel={getBaseField("destination").label}
          onClose={() => setOpenDetailId(null)}
        />
      )}

      {role !== "employee" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t("batchReview.actionsTitle")}</CardTitle>
            <CardDescription>
              {t("batchReview.actionsDescription")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedExpenses.length > 0 && verifyCount + approveCount + rejectCount === 0 && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  No eligible expenses selected. Expenses that are already approved/rejected or waiting for a different reviewer step cannot be actioned here.
                </span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="batch-review-comment">{t("batchReview.commentLabel")}</Label>
              <Textarea
                id="batch-review-comment"
                placeholder={t("batchReview.commentPlaceholder")}
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                rows={3}
              />
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <Button
                type="button"
                variant="secondary"
                disabled={!!actionLoading || !selectedSingleExpense}
                onClick={openCorrectionDialog}
              >
                Correct selected expense
              </Button>
              <Button
                variant="destructive"
                disabled={!!actionLoading || rejectCount === 0}
                onClick={() => runBatchAction("reject")}
              >
                {actionLoading === "reject" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {batchReviewActionLabel("reject", rejectCount)}
              </Button>
              <Button
                variant="outline"
                disabled={!!actionLoading || verifyCount === 0}
                onClick={() => runBatchAction("verify")}
              >
                {actionLoading === "verify" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {batchReviewActionLabel("verify", verifyCount)}
              </Button>
              <Button
                disabled={!!actionLoading || approveCount === 0}
                onClick={() => runBatchAction("approve")}
              >
                {actionLoading === "approve" && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {batchReviewActionLabel("approve", approveCount)}
              </Button>
            </div>
            {actionProgress.status !== "idle" && (
              <AsyncOperationProgress
                status={actionProgress.status}
                title={actionProgress.phase}
                showSuccess={actionProgress.status === "success"}
                compact
              />
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={correctionDialogOpen} onOpenChange={setCorrectionDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Correct selected batch expense</DialogTitle>
            <DialogDescription>
              Update one selected expense in this batch and save reviewer correction audit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label htmlFor="batch-corr-title">{getBaseField("title").label}</Label>
              <Input id="batch-corr-title" value={corrTitle} onChange={(e) => setCorrTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="batch-corr-destination">{getBaseField("destination").label}</Label>
              <Input
                id="batch-corr-destination"
                value={corrDestination}
                onChange={(e) => setCorrDestination(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="batch-corr-date">Date of expense</Label>
              <Input
                id="batch-corr-date"
                type="date"
                value={corrExpenseDate}
                onChange={(e) => setCorrExpenseDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="batch-corr-purpose">{getBaseField("purpose").label}</Label>
              <Textarea
                id="batch-corr-purpose"
                rows={2}
                value={corrPurpose}
                onChange={(e) => setCorrPurpose(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="batch-corr-category">{getBaseField("category").label}</Label>
              <ExpenseCategorySelect
                id="batch-corr-category"
                organizationId={organizationId}
                value={corrCategory}
                onChange={setCorrCategory}
              />
            </div>
            <div>
              <Label htmlFor="batch-corr-amount">{getBaseField("amount").label}</Label>
              <Input
                id="batch-corr-amount"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                onWheelCapture={blurFocusedNumberInputOnWheel}
                value={corrAmount}
                onChange={(e) => setCorrAmount(e.target.value)}
              />
            </div>
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
              organizationId={organizationId}
              userId={userId}
              allowNested={allowNestedConditional}
            />
            <div>
              <Label htmlFor="batch-corr-reason">Reason for correction (audit)</Label>
              <Textarea
                id="batch-corr-reason"
                rows={2}
                value={corrReason}
                onChange={(e) => setCorrReason(e.target.value)}
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
            <Button onClick={() => void submitCorrection()} disabled={correctionLoading}>
              {correctionLoading ? "Saving..." : "Save correction"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
