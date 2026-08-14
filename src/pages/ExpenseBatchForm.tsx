import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@/i18n";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Plus,
  Copy,
  Trash2,
  Send,
  LayoutGrid,
  Table2,
  RotateCcw,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { formatINR } from "@/lib/format";
import { FileUpload } from "@/components/FileUpload";
import {
  ExpenseService,
  type BatchSubmitResult,
} from "@/services/ExpenseService";
import {
  DEFAULT_BASE_FIELD_CONFIG,
  resolveBaseFieldConfig,
  type BaseExpenseFieldKey,
  type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";
import { useBatchExpenseEntry } from "@/hooks/useBatchExpenseEntry";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { BatchLineFormFields } from "@/components/BatchLineFormFields";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";
import { useCanSubmitOwnExpenses } from "@/hooks/useCanSubmitOwnExpenses";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import {
  BATCH_EXPENSE_MAX_LINES,
  BATCH_EXPENSE_MIN_LINES,
  type BatchExpenseAttachmentMode,
} from "@/lib/expenseBatchConstants";
import {
  batchLineTotal,
  validateBatchLines,
  validateBatchSharedContext,
  validateBatchAttachments,
  validateBatchCustomFieldsFromPlan,
  type BatchLineInput,
  type BatchSharedFormValues,
  type LineCustomFieldInput,
} from "@/lib/expenseBatchValidation";
import { fetchRecommendedCategories } from "@/lib/recommendedCategories";
import { BatchCategoryField } from "@/components/BatchCategoryField";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import { BatchLineReceiptSection } from "@/components/BatchLineReceiptSection";
import { BatchExpenseLinesTable } from "@/components/BatchExpenseLinesTable";
import { BatchSharedCategoryFields } from "@/components/BatchSharedCategoryFields";
import {
  uniqueCategoriesInLines,
} from "@/lib/batchFormFields";
import {
  applyBatchFieldPlanToLines,
  getPerLineAssignmentsForCategory,
} from "@/lib/batchFieldPlan";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import { useBatchFieldPlan } from "@/hooks/useBatchFieldPlan";
import { trackBaseFieldSelections, trackFormFieldSelectionsForCategory } from "@/lib/recommendedFormFieldOptions";
import { NumberInput } from "@/components/NumberInput";
import type { TempUploadMeta } from "@/lib/expenseBatchAttachments";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useViewportMode } from "@/hooks/useViewportMode";

type WizardStep = 1 | 2 | 3 | "results";
type LineViewMode = "cards" | "table";

function newLine(): BatchLineInput {
  return {
    clientId: crypto.randomUUID(),
    title: "",
    amount: 0,
    category: "",
    destination: "",
    purpose: "",
    tempReceiptFilenames: [],
  };
}

export default function ExpenseBatchForm() {
  const { t, i18n } = useTranslation(["expenses", "common"]);
  const navigate = useNavigate();
  const { user, userRole, organizationId, organizationFeatureFlags } = useAuth();
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;
  const baseFieldCustomizationEnabled =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization] === true;
  const { toast } = useToast();
  const { isMobile } = useViewportMode();
  const { canSubmitExpenses, loading: canSubmitLoading } = useCanSubmitOwnExpenses();
  const { batchExpenseEntryEnabled: batchEnabled, batchEntryLoading } =
    useBatchExpenseEntry();

  const [step, setStep] = useState<WizardStep>(1);
  const [loading, setLoading] = useState(false);

  const {
    progress: submitProgress,
    startOperation: startSubmitProgress,
    updateOperation: updateSubmitProgress,
    completeOperation: completeSubmitProgress,
    warnOperation: warnSubmitProgress,
    failOperation: failSubmitProgress,
    resetOperation: resetSubmitProgress,
  } = useOperationProgress();
  const [categories, setCategories] = useState<string[]>([]);
  const [attachmentLimit, setAttachmentLimit] = useState(50);
  const [attachmentMode, setAttachmentMode] = useState<BatchExpenseAttachmentMode>("per_line");
  const [userBalance, setUserBalance] = useState<number | null>(null);
  const [baseFieldConfig, setBaseFieldConfig] =
    useState<Record<BaseExpenseFieldKey, BaseFieldConfig>>(DEFAULT_BASE_FIELD_CONFIG);
  const [baseFieldConfigLoaded, setBaseFieldConfigLoaded] = useState(false);
  const [submitResult, setSubmitResult] = useState<BatchSubmitResult | null>(null);
  const [recommendedCategories, setRecommendedCategories] = useState<string[]>([]);
  const [lineViewMode, setLineViewMode] = useState<LineViewMode>("cards");
  const [receiptTick, setReceiptTick] = useState(0);

  const [expenseDate, setExpenseDate] = useState<Date>(new Date());
  const [sharedDestination, setSharedDestination] = useState("");
  const [batchLabel, setBatchLabel] = useState("");
  const [sharedTitle, setSharedTitle] = useState("");
  const [lines, setLines] = useState<BatchLineInput[]>([newLine(), newLine()]);
  /** Custom fields asked once per batch, keyed by template ID. */
  const [batchSharedFormValues, setBatchSharedFormValues] = useState<BatchSharedFormValues>({});

  /** Branch definitions keyed by category ID, pre-fetched for per-line conditional dropdowns. */
  const [branchesByCategoryId, setBranchesByCategoryId] = useState<Record<string, OptionBranchDefinition[]>>({});
  /** Tracks which category IDs have already been fetched to avoid duplicate requests. */
  const fetchedBranchCategoryIdsRef = useRef<Set<string>>(new Set());

  const { plan, categoryIdByName, loading: planLoading, error: planError, reload: planReload } = useBatchFieldPlan(
    organizationId,
    uniqueCategoriesInLines(lines),
  );

  /** category ID → category name (inverse of categoryIdByName) */
  const categoryNameById = useMemo(
    () => Object.fromEntries(Object.entries(categoryIdByName).map(([n, id]) => [id, n])),
    [categoryIdByName],
  );

  // Pre-fetch branch definitions for all per-line "select" category IDs in the plan.
  // Runs whenever plan.perLine changes (new categories added to the batch).
  useEffect(() => {
    if (!organizationId || !allowConditionalDropdown) return;
    const catIds = [...new Set(plan.perLine.map((p) => p.categoryId))];
    const missing = catIds.filter((id) => !fetchedBranchCategoryIdsRef.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => fetchedBranchCategoryIdsRef.current.add(id));
    void Promise.all(
      missing.map(async (catId) => {
        const catName = categoryNameById[catId] ?? "";
        if (!catName) return;
        const branches = await ExpenseService.fetchOptionBranchesForCategory(organizationId, catName);
        setBranchesByCategoryId((prev) => ({ ...prev, [catId]: branches }));
      }),
    );
  }, [plan.perLine, organizationId, allowConditionalDropdown, categoryNameById]);

  const sessionTempFilenamesRef = useRef<Set<string>>(new Set());
  const sessionTempUploadMetaRef = useRef<Map<string, TempUploadMeta>>(new Map());
  const lineTempFilenamesRef = useRef<Map<string, Set<string>>>(new Map());
  const isSubmittingRef = useRef(false);

  const translatedBaseFields = useMemo(
    () => translateBaseFieldConfig(baseFieldConfig, t),
    [baseFieldConfig, t, i18n.language],
  );

  const getBaseField = (key: BaseExpenseFieldKey): BaseFieldConfig =>
    translatedBaseFields[key] ||
    translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, t)[key];

  useEffect(() => {
    if (canSubmitLoading || batchEntryLoading) return;
    if (!canSubmitExpenses) {
      toast({
        variant: "destructive",
        title: "Access denied",
        description: "Your role cannot submit expenses.",
      });
      navigate(userRole === "admin" || userRole === "cashier" ? "/admin/expenses" : "/expenses");
      return;
    }
    if (!batchEnabled) {
      toast({
        variant: "destructive",
        title: "Not available",
        description:
          "Batch expense entry is not enabled for your organization. Ask your master admin to turn on “Allow batch expense entry”.",
      });
      navigate(userRole === "admin" || userRole === "cashier" ? "/admin/expenses" : "/expenses");
    }
  }, [
    batchEnabled,
    batchEntryLoading,
    canSubmitExpenses,
    canSubmitLoading,
    navigate,
    toast,
    userRole,
  ]);

  useEffect(() => {
    const init = async () => {
      if (!organizationId || !user?.id) {
        setBaseFieldConfigLoaded(true);
        return;
      }
      try {
        const { data: cats } = await supabase
          .from("expense_categories")
          .select("name")
          .eq("organization_id", organizationId)
          .eq("active", true)
          .order("name");
        if (cats) {
          const names = cats.map((c) => c.name);
          setCategories(names);
          if (names.length > 0 && organizationId && user.id) {
            const rec = await fetchRecommendedCategories(organizationId, user.id, names);
            setRecommendedCategories(rec);
          }
        }

        const { data: orgSettings } = await supabase
          .from("organization_settings")
          .select("attachment_required_above_amount, batch_expense_attachment_mode")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (orgSettings?.attachment_required_above_amount != null) {
          setAttachmentLimit(Number(orgSettings.attachment_required_above_amount));
        }
        const mode = orgSettings?.batch_expense_attachment_mode;
        if (mode === "shared" || mode === "per_line") setAttachmentMode(mode);

        const { data: profile } = await supabase
          .from("profiles")
          .select("balance")
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();
        if (profile?.balance != null) setUserBalance(Number(profile.balance));

        const { data: fields } = await (supabase as any)
          .from("organization_expense_form_fields")
          .select("*")
          .eq("organization_id", organizationId);
        if (fields) {
          setBaseFieldConfig(resolveBaseFieldConfig(fields as Partial<BaseFieldConfig>[]));
        }
      } finally {
        setBaseFieldConfigLoaded(true);
      }
    };
    void init();
  }, [organizationId, user?.id]);

  const registerTempUpload = (storagePath: string, meta: TempUploadMeta, lineClientId?: string) => {
    if (lineClientId) {
      const set = lineTempFilenamesRef.current.get(lineClientId) ?? new Set();
      set.add(storagePath);
      lineTempFilenamesRef.current.set(lineClientId, set);
      sessionTempUploadMetaRef.current.set(storagePath, meta);
    } else {
      sessionTempFilenamesRef.current.add(storagePath);
      sessionTempUploadMetaRef.current.set(storagePath, meta);
    }
  };

  const buildMetaRecord = (): Record<string, TempUploadMeta> => {
    const out: Record<string, TempUploadMeta> = {};
    sessionTempUploadMetaRef.current.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  };

  const linesWithTemps = (): BatchLineInput[] =>
    lines.map((l) => ({
      ...l,
      tempReceiptFilenames: Array.from(lineTempFilenamesRef.current.get(l.clientId) ?? []),
    }));

  const getReceiptCount = (clientId: string) => {
    void receiptTick;
    return lineTempFilenamesRef.current.get(clientId)?.size ?? 0;
  };

  const updateLine = (clientId: string, patch: Partial<BatchLineInput>) => {
    setLines((prev) =>
      prev.map((l) => (l.clientId === clientId ? { ...l, ...patch } : l)),
    );
  };

  const handleSharedTitleChange = (title: string) => {
    setSharedTitle(title);
    setLines((prev) => prev.map((l) => ({ ...l, title })));
  };

  const duplicateLineAt = (index: number) => {
    const line = lines[index];
    if (!line) return;
    setLines((prev) => [
      ...prev.slice(0, index + 1),
      {
        ...line,
        clientId: crypto.randomUUID(),
        title: line.title,
        category: line.category,
        purpose: line.purpose,
        destination: line.destination,
        tempReceiptFilenames: [],
      },
      ...prev.slice(index + 1),
    ]);
  };

  const registerLineReceipt = (
    clientId: string,
    storagePath: string,
    meta: TempUploadMeta,
  ) => {
    registerTempUpload(storagePath, meta, clientId);
    setReceiptTick((t) => t + 1);
  };

  const deleteBatchTempUploads = async () => {
    const paths = new Set<string>();
    sessionTempFilenamesRef.current.forEach((p) => paths.add(p));
    lineTempFilenamesRef.current.forEach((set) => set.forEach((p) => paths.add(p)));
    if (paths.size === 0) return;
    // DOC-078: staging copies are RETAINED, not deleted. The temp/ object is the only
    // second copy a receipt has until the archive tier exists, and DOC-077 §5d showed
    // what a single-copy receipt costs. We only drop the local tracking refs here;
    // reclaiming staging bytes is a separate, server-side retention job.
    sessionTempFilenamesRef.current.clear();
    sessionTempUploadMetaRef.current.clear();
    lineTempFilenamesRef.current.clear();
  };

  const resetBatchFormState = () => {
    setStep(1);
    setExpenseDate(new Date());
    setSharedDestination("");
    setBatchLabel("");
    setSharedTitle("");
    setLines([newLine(), newLine()]);
    setBatchSharedFormValues({});
    setSubmitResult(null);
    setReceiptTick((t) => t + 1);
  };

  const handleClearForm = async () => {
    if (loading) return;
    try {
      await deleteBatchTempUploads();
      resetBatchFormState();
      toast({
        title: t("form.clearFormDone"),
        description: t("form.clearFormDoneNew"),
      });
    } catch (err) {
      console.error("Failed to clear batch expense form:", err);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: t("form.clearFormFailed"),
      });
    }
  };

  /** Fetch branch definitions for conditional dropdown validation. */
  const fetchCategoryBranches = async (
    cats: string[],
  ): Promise<Map<string, import("@/lib/conditionalFormFieldTypes").OptionBranchDefinition[]>> => {
    const out = new Map<string, import("@/lib/conditionalFormFieldTypes").OptionBranchDefinition[]>();
    if (!organizationId || !allowConditionalDropdown) return out;
    await Promise.all(
      cats.map(async (cat) => {
        const branches = await ExpenseService.fetchOptionBranchesForCategory(organizationId, cat);
        out.set(cat, branches);
      }),
    );
    return out;
  };

  const goNextFromStep1 = () => {
    const ctxCheck = validateBatchSharedContext(
      { expenseDate, sharedDestination, label: batchLabel },
      translatedBaseFields,
    );
    if (!ctxCheck.ok) {
      toast({ variant: "destructive", title: "Validation", description: ctxCheck.message });
      return;
    }
    const titleCfg = getBaseField("title");
    if (titleCfg.is_visible && titleCfg.is_required && !sharedTitle.trim()) {
      toast({ variant: "destructive", title: "Validation", description: `${titleCfg.label} is required` });
      return;
    }
    setStep(2);
  };

  const goNextFromStep2 = async () => {
    const lineCheck = validateBatchLines(linesWithTemps(), translatedBaseFields);
    if (!lineCheck.ok) {
      toast({ variant: "destructive", title: "Validation", description: lineCheck.message });
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const titleCfg = getBaseField("title");
      if (titleCfg.is_visible && titleCfg.is_required && !line.title.trim()) {
        toast({
          variant: "destructive",
          title: "Validation",
          description: `Line ${i + 1}: ${titleCfg.label} is required`,
        });
        return;
      }
      const dest =
        line.destination?.trim() || sharedDestination.trim() || "";
      const destCfg = getBaseField("destination");
      if (destCfg.is_visible && destCfg.is_required && !dest) {
        toast({
          variant: "destructive",
          title: "Validation",
          description: `Line ${i + 1}: ${destCfg.label} is required`,
        });
        return;
      }
    }
    if (attachmentMode === "per_line") {
      const attachCheck = validateBatchAttachments({
        lines: linesWithTemps(),
        attachmentLimit,
        mode: attachmentMode,
        sharedTempFilenames: [],
      });
      if (!attachCheck.ok) {
        toast({ variant: "destructive", title: "Bills required", description: attachCheck.message });
        return;
      }
    }

    // Validate required custom template and branch fields before advancing.
    const mergedForValidation = applyBatchFieldPlanToLines(
      linesWithTemps(),
      plan,
      batchSharedFormValues,
      categoryNameById,
      categoryIdByName,
    );
    const uniqueCats = uniqueCategoriesInLines(mergedForValidation);
    const categoryBranches = await fetchCategoryBranches(uniqueCats);
    const customCheck = validateBatchCustomFieldsFromPlan({
      lines: mergedForValidation.map((l, i) => ({
        lineIndex: i,
        lineLabel: l.title?.trim() || l.category?.trim() || `Line ${i + 1}`,
        category: l.category?.trim() || "other",
        formFieldValues: l.formFieldValues ?? {},
        branchValues: l.branchValues ?? {},
      }) satisfies LineCustomFieldInput),
      plan,
      batchSharedFormValues,
      categoryIdByName,
      categoryBranches,
      allowConditionalDropdown,
      allowNestedConditional,
      configLoaded: baseFieldConfigLoaded,
    });
    if (!customCheck.ok) {
      toast({ variant: "destructive", title: "Additional fields required", description: customCheck.message });
      return;
    }

    setStep(3);
  };

  const handleSubmit = async () => {
    if (!user?.id) return;
    const withTemps = linesWithTemps();
    const attachCheck = validateBatchAttachments({
      lines: withTemps,
      attachmentLimit,
      mode: attachmentMode,
      sharedTempFilenames: Array.from(sessionTempFilenamesRef.current),
    });
    if (!attachCheck.ok) {
      toast({ variant: "destructive", title: "Bills required", description: attachCheck.message });
      return;
    }
    const mergedLines = applyBatchFieldPlanToLines(
      withTemps,
      plan,
      batchSharedFormValues,
      categoryNameById,
      categoryIdByName,
    );

    // ── Validate required custom template and branch fields before any writes ──
    const submitCategoryBranches = await fetchCategoryBranches(uniqueCategoriesInLines(mergedLines));
    const customFieldCheck = validateBatchCustomFieldsFromPlan({
      lines: mergedLines.map((l, i) => ({
        lineIndex: i,
        lineLabel: l.title?.trim() || l.category?.trim() || `Line ${i + 1}`,
        category: l.category?.trim() || "other",
        formFieldValues: l.formFieldValues ?? {},
        branchValues: l.branchValues ?? {},
      }) satisfies LineCustomFieldInput),
      plan,
      batchSharedFormValues,
      categoryIdByName,
      categoryBranches: submitCategoryBranches,
      allowConditionalDropdown,
      allowNestedConditional,
      configLoaded: baseFieldConfigLoaded,
    });
    if (!customFieldCheck.ok) {
      toast({ variant: "destructive", title: "Additional fields required", description: customFieldCheck.message });
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    resetSubmitProgress();
    startSubmitProgress(t("progress.batchValidating"), {
      description: t("progress.batchValidatingHint"),
      currentStep: 1,
      totalSteps: 3,
    });
    const linesPrepared = [];
    for (const l of mergedLines) {
      const formFieldValues = l.formFieldValues || {};
      const branchValues = l.branchValues || {};
      const visibleBranchIds =
        allowConditionalDropdown && organizationId
          ? [
              ...getVisibleBranchIds(
                await ExpenseService.fetchOptionBranchesForCategory(
                  organizationId,
                  l.category?.trim() || "other",
                ),
                formFieldValues,
                branchValues,
                allowNestedConditional,
              ),
            ]
          : undefined;

      linesPrepared.push({
        title: l.title,
        amount: Number(l.amount),
        category: l.category?.trim() || "other",
        destination: l.destination?.trim() || sharedDestination.trim() || "—",
        purpose: l.purpose?.trim() || undefined,
        tempReceiptFilenames: l.tempReceiptFilenames,
        formFieldValues: Object.keys(formFieldValues).length ? formFieldValues : undefined,
        branchValues: Object.keys(branchValues).length ? branchValues : undefined,
        visibleBranchIds,
      });
    }

    try {
      updateSubmitProgress(t("progress.batchSubmitting"), {
        description: t("progress.batchSubmittingLine", { current: 0, total: linesPrepared.length }),
        currentStep: 2,
        totalSteps: 3,
      });
      const result = await ExpenseService.submitExpenseBatch(user.id, {
        shared: {
          expenseDate,
          sharedDestination: sharedDestination || undefined,
          label: batchLabel || undefined,
        },
        lines: linesPrepared,
        attachmentMode,
        sharedTempFilenames:
          attachmentMode === "shared"
            ? Array.from(sessionTempFilenamesRef.current)
            : undefined,
        metaByFilename: buildMetaRecord(),
      });
      setSubmitResult(result);
      const succeeded = result.results.filter((r) => r.ok).length;
      const failed = result.results.filter((r) => !r.ok).length;
      if (failed > 0) {
        warnSubmitProgress(
          t("progress.batchPartial", { succeeded, total: result.results.length }),
          { description: t("progress.batchPartialHint", { failed }) },
        );
      } else {
        completeSubmitProgress(t("progress.batchComplete"));
      }
      setStep("results");

      if (user?.id && organizationId) {
        for (const r of result.results) {
          if (!r.ok) continue;
          const line = linesPrepared[r.lineIndex];
          const cat = line.category?.trim() || "other";
          const catId = categoryIdByName[cat];
          const sharedForm: Record<string, string> = {};
          const sharedBranch: Record<string, string> = {};
          if (catId) {
            for (const sf of plan.shared) {
              if (!sf.categoryIds.includes(catId)) continue;
              const vals = batchSharedFormValues[sf.templateId];
              if (vals) {
                Object.assign(sharedForm, vals.fields);
                Object.assign(sharedBranch, vals.branches);
              }
            }
          }
          const mergedForm = { ...sharedForm, ...(line.formFieldValues || {}) };
          const mergedBranch = { ...sharedBranch, ...(line.branchValues || {}) };
          void trackFormFieldSelectionsForCategory(
            organizationId,
            user.id,
            cat,
            mergedForm,
            mergedBranch,
            allowConditionalDropdown,
          );
          if (baseFieldCustomizationEnabled) {
            void trackBaseFieldSelections(
              organizationId,
              user.id,
              (Object.keys(baseFieldConfig) as BaseExpenseFieldKey[]).map((k) => ({
                field_key: baseFieldConfig[k].field_key,
                input_type: baseFieldConfig[k].input_type,
              })),
              {
                category: line.category,
                title: line.title,
                destination: line.destination?.trim() || sharedDestination,
                purpose: line.purpose,
                amount: line.amount ? String(line.amount) : "",
              },
            );
          }
        }
      }

      sessionTempFilenamesRef.current.clear();
      sessionTempUploadMetaRef.current.clear();
      lineTempFilenamesRef.current.clear();

      toast({
        title: "Batch submitted",
        description: `${result.successCount} of ${linesPrepared.length} expenses submitted.`,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Submit failed";
      failSubmitProgress(t("progress.batchSubmitting"), msg);
      toast({ variant: "destructive", title: "Error", description: msg });
    } finally {
      isSubmittingRef.current = false;
      setLoading(false);
    }
  };

  const subtotal = batchLineTotal(lines);
  const showCategory = getBaseField("category").is_visible;
  const categoryRequired = getBaseField("category").is_required;
  const showPurpose = getBaseField("purpose").is_visible;
  const purposeRequired = getBaseField("purpose").is_required;
  const showDestination = getBaseField("destination").is_visible;

  if (canSubmitLoading || batchEntryLoading || !baseFieldConfigLoaded) {
    return (
      <div className="py-12 text-center text-muted-foreground">{t("batch.loadingForm")}</div>
    );
  }

  if (!batchEnabled) return null;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-10">
      <div className="text-center">
        <h1 className="text-2xl sm:text-3xl font-bold">{t("batch.title")}</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          {t("batch.stepDescription", { step: step === "results" ? t("batch.stepComplete") : step })}
        </p>
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("batch.sharedDetails")}</CardTitle>
            <CardDescription>{t("batch.sharedDetailsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => void handleClearForm()}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("form.clearForm")}
            </Button>
            <div>
              <Label>{t("batch.batchLabel")}</Label>
              <Input
                value={batchLabel}
                onChange={(e) => setBatchLabel(e.target.value)}
                placeholder={t("batch.batchLabelPlaceholder")}
              />
            </div>
            {getBaseField("title").is_visible && (
              <div>
                <Label>
                  {getBaseField("title").label}
                  {getBaseField("title").is_required ? " *" : " (same for all expenses)"}
                </Label>
                <Input
                  value={sharedTitle}
                  onChange={(e) => handleSharedTitleChange(e.target.value)}
                  placeholder={getBaseField("title").is_required ? `${getBaseField("title").label} *` : `${getBaseField("title").label} (same for all expenses)`}
                />
              </div>
            )}
            {getBaseField("expense_date").is_visible && (
              <div>
                <Label>{getBaseField("expense_date").label} *</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start">
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {format(expenseDate, "PPP")}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={expenseDate}
                      onSelect={(d) => d && setExpenseDate(d)}
                      disabled={(date) => date > new Date()}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            )}
            {getBaseField("destination").is_visible && (
              <div>
                <Label>
                  {getBaseField("destination").label}
                  {getBaseField("destination").is_required ? " *" : " (default for all lines)"}
                </Label>
                <BaseExpenseFieldInput
                  config={getBaseField("destination")}
                  value={sharedDestination}
                  onChange={(v) => setSharedDestination(v)}
                  featureEnabled={baseFieldCustomizationEnabled}
                  organizationId={organizationId}
                  userId={user?.id}
                  defaultControl={
                    <Input
                      value={sharedDestination}
                      onChange={(e) => setSharedDestination(e.target.value)}
                    />
                  }
                />
              </div>
            )}
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => navigate("/expenses")}>
                Cancel
              </Button>
              <Button onClick={goNextFromStep1}>
                Next <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <div>
                <CardTitle>Expense lines</CardTitle>
                <CardDescription>
                  Add {BATCH_EXPENSE_MIN_LINES}–{BATCH_EXPENSE_MAX_LINES} expenses — verify in card
                  or table view
                </CardDescription>
              </div>
              {!isMobile && (
                <div className="flex rounded-lg border p-1 bg-muted/40 shrink-0">
                  <Button
                    type="button"
                    variant={lineViewMode === "cards" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8"
                    onClick={() => setLineViewMode("cards")}
                  >
                    <LayoutGrid className="h-4 w-4 mr-1" />
                    Cards
                  </Button>
                  <Button
                    type="button"
                    variant={lineViewMode === "table" ? "secondary" : "ghost"}
                    size="sm"
                    className="h-8"
                    onClick={() => setLineViewMode("table")}
                  >
                    <Table2 className="h-4 w-4 mr-1" />
                    Table
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => void handleClearForm()}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("form.clearForm")}
            </Button>
            {isMobile && uniqueCategoriesInLines(lines).length > 0 && (
              <div className="space-y-0.5 pt-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Batch Information
                </p>
                <p className="text-xs text-muted-foreground">
                  These fields apply to all lines in this batch
                </p>
              </div>
            )}
            {planError && (
              <div className="rounded-md border border-destructive/25 bg-destructive/5 p-3 flex items-center justify-between gap-3">
                <p className="text-sm text-destructive">
                  Could not load the expense form configuration. Retry before submitting.
                </p>
                <Button variant="outline" size="sm" onClick={planReload} disabled={planLoading}>
                  {planLoading ? "Retrying…" : "Retry"}
                </Button>
              </div>
            )}
            {organizationId &&
              plan.shared.map((sf) => (
                <BatchSharedCategoryFields
                  key={`batch-field-${sf.templateId}`}
                  organizationId={organizationId}
                  sharedField={sf}
                  fields={batchSharedFormValues[sf.templateId]?.fields ?? {}}
                  branches={batchSharedFormValues[sf.templateId]?.branches ?? {}}
                  onFieldsChange={(fields) =>
                    setBatchSharedFormValues((prev) => ({
                      ...prev,
                      [sf.templateId]: {
                        fields,
                        branches: prev[sf.templateId]?.branches ?? {},
                      },
                    }))
                  }
                  onBranchesChange={(branches) =>
                    setBatchSharedFormValues((prev) => ({
                      ...prev,
                      [sf.templateId]: {
                        fields: prev[sf.templateId]?.fields ?? {},
                        branches,
                      },
                    }))
                  }
                  allowConditionalDropdown={allowConditionalDropdown}
                  allowNested={allowNestedConditional}
                  userId={user?.id}
                />
              ))}
            {!isMobile && lineViewMode === "table" ? (
              <BatchExpenseLinesTable
                lines={lines}
                categories={categories}
                recommendedCategories={recommendedCategories}
                attachmentLimit={attachmentLimit}
                attachmentMode={attachmentMode}
                sharedDestination={sharedDestination}
                sharedTitle={sharedTitle}
                showCategory={showCategory}
                categoryLabel={getBaseField("category").label}
                categoryRequired={categoryRequired}
                titleLabel={getBaseField("title").label}
                titleRequired={getBaseField("title").is_required}
                amountLabel={getBaseField("amount").label}
                showPurpose={showPurpose}
                purposeLabel={getBaseField("purpose").label}
                purposeRequired={purposeRequired}
                showDestination={showDestination}
                destinationLabel={getBaseField("destination").label}
                baseFieldConfig={translatedBaseFields}
                baseFieldCustomizationEnabled={baseFieldCustomizationEnabled}
                organizationId={organizationId}
                userId={user?.id}
                getReceiptCount={getReceiptCount}
                onUpdateLine={updateLine}
                onDuplicate={duplicateLineAt}
                onRemove={(id) =>
                  setLines((prev) => prev.filter((l) => l.clientId !== id))
                }
                onReceiptUpload={registerLineReceipt}
              />
            ) : (
              <>
                {isMobile && (
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Individual Expenses
                  </p>
                )}
                {lines.map((line, index) => (
                <div
                  key={line.clientId}
                  className="rounded-lg border p-3 space-y-2 bg-muted/20"
                >
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium">Line {index + 1}</span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => duplicateLineAt(index)}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={lines.length <= BATCH_EXPENSE_MIN_LINES}
                        onClick={() =>
                          setLines((prev) => prev.filter((l) => l.clientId !== line.clientId))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {showCategory && (
                    <BatchCategoryField
                      label={getBaseField("category").label}
                      required={categoryRequired}
                      value={line.category}
                      categories={categories}
                      recommendedCategories={recommendedCategories}
                      onChange={(v) =>
                        updateLine(line.clientId, {
                          category: v,
                          formFieldValues: {},
                          branchValues: {},
                        })
                      }
                    />
                  )}
                  {organizationId && line.category?.trim() && (() => {
                    const catId = categoryIdByName[line.category.trim()] ?? "";
                    const perLineAssignments = getPerLineAssignmentsForCategory(plan, catId);
                    if (perLineAssignments.length === 0) return null;
                    return (
                      <BatchLineFormFields
                        assignments={perLineAssignments}
                        optionBranches={allowConditionalDropdown ? (branchesByCategoryId[catId] ?? []) : []}
                        formFieldValues={line.formFieldValues || {}}
                        branchValues={line.branchValues || {}}
                        onFormFieldValuesChange={(formFieldValues) =>
                          updateLine(line.clientId, { formFieldValues })
                        }
                        onBranchValuesChange={(branchValues) =>
                          updateLine(line.clientId, { branchValues })
                        }
                        allowNested={allowNestedConditional}
                        organizationId={organizationId}
                        userId={user?.id}
                      />
                    );
                  })()}
                  <div className="grid gap-2 sm:grid-cols-2">
                    {getBaseField("title").is_visible && (
                      <div>
                        <Label className="text-xs text-muted-foreground">{getBaseField("title").label}</Label>
                        <p className="text-sm border rounded-md px-3 py-2 bg-muted/50 min-h-[36px]">
                          {sharedTitle || <span className="text-muted-foreground">—</span>}
                        </p>
                      </div>
                    )}
                    <div>
                      <Label>{getBaseField("amount").label} (₹) *</Label>
                      <BaseExpenseFieldInput
                        config={getBaseField("amount")}
                        value={line.amount ? String(line.amount) : ""}
                        onChange={(v) =>
                          updateLine(line.clientId, { amount: parseFloat(v) || 0 })
                        }
                        featureEnabled={baseFieldCustomizationEnabled}
                        organizationId={organizationId}
                        userId={user?.id}
                        defaultControl={
                          <NumberInput
                            min={0}
                            step="0.01"
                            value={line.amount || ""}
                            onChange={(e) =>
                              updateLine(line.clientId, {
                                amount: parseFloat(e.target.value) || 0,
                              })
                            }
                          />
                        }
                      />
                    </div>
                  </div>
                  {showDestination && !sharedDestination.trim() && (
                    <div>
                      <Label>{getBaseField("destination").label}</Label>
                      <BaseExpenseFieldInput
                        config={getBaseField("destination")}
                        value={line.destination || ""}
                        onChange={(v) => updateLine(line.clientId, { destination: v })}
                        featureEnabled={baseFieldCustomizationEnabled}
                        organizationId={organizationId}
                        userId={user?.id}
                        defaultControl={
                          <Input
                            value={line.destination || ""}
                            onChange={(e) =>
                              updateLine(line.clientId, { destination: e.target.value })
                            }
                          />
                        }
                      />
                    </div>
                  )}
                  {showPurpose && (
                    <div>
                      <Label>
                        {getBaseField("purpose").label}
                        {purposeRequired ? " *" : ""}
                      </Label>
                      <BaseExpenseFieldInput
                        config={getBaseField("purpose")}
                        value={line.purpose || ""}
                        onChange={(v) => updateLine(line.clientId, { purpose: v })}
                        featureEnabled={baseFieldCustomizationEnabled}
                        organizationId={organizationId}
                        userId={user?.id}
                        defaultControl={
                          <Textarea
                            value={line.purpose || ""}
                            onChange={(e) => updateLine(line.clientId, { purpose: e.target.value })}
                            rows={2}
                            placeholder={purposeRequired ? `${getBaseField("purpose").label} *` : getBaseField("purpose").label}
                          />
                        }
                      />
                    </div>
                  )}
                  {attachmentMode === "per_line" && (
                    <BatchLineReceiptSection
                      amount={Number(line.amount) || 0}
                      attachmentLimit={attachmentLimit}
                      receiptCount={getReceiptCount(line.clientId)}
                      onUpload={(path, meta) => registerLineReceipt(line.clientId, path, meta)}
                    />
                  )}
                </div>
              ))}
              </>
            )}
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={lines.length >= BATCH_EXPENSE_MAX_LINES}
              onClick={() => setLines((prev) => [...prev, { ...newLine(), title: sharedTitle }])}
            >
              <Plus className="h-4 w-4 mr-2" /> Add line
            </Button>
            <div className="flex justify-between pt-2">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ChevronLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={goNextFromStep2} disabled={planLoading || !!planError}>
                {planLoading ? "Loading fields…" : "Review"} <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>Review and submit</CardTitle>
            <CardDescription>
              {lines.length} expenses · Total {formatINR(subtotal)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => void handleClearForm()}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              {t("form.clearForm")}
            </Button>
            {userBalance != null && subtotal > userBalance && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Your balance ({formatINR(userBalance)}) is less than this batch total. Submission
                is allowed; approval may require a balance top-up.
              </div>
            )}
            {isMobile ? (
              <div className="space-y-2">
                {lines.map((line, i) => (
                  <div
                    key={line.clientId}
                    className="rounded-lg border p-3 bg-muted/20"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {i + 1}. {line.title}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {line.category || "—"}
                        </p>
                        {getBaseField("purpose").is_visible && line.purpose?.trim() && (
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {line.purpose}
                          </p>
                        )}
                      </div>
                      <p className="text-sm font-semibold tabular-nums shrink-0">
                        {formatINR(line.amount)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>{getBaseField("title").label}</TableHead>
                    <TableHead>{getBaseField("category").label}</TableHead>
                    {getBaseField("purpose").is_visible && <TableHead>{getBaseField("purpose").label}</TableHead>}
                    <TableHead>{getBaseField("amount").label}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line, i) => (
                    <TableRow key={line.clientId}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell>{line.title}</TableCell>
                      <TableCell className="capitalize">{line.category || "—"}</TableCell>
                      {getBaseField("purpose").is_visible && (
                        <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                          {line.purpose?.trim() || "—"}
                        </TableCell>
                      )}
                      <TableCell>{formatINR(line.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {attachmentMode === "shared" && (
              <div className="space-y-2 border-t pt-4">
                <BatchLineReceiptSection
                  amount={Math.max(...lines.map((l) => Number(l.amount) || 0), 0)}
                  attachmentLimit={attachmentLimit}
                  receiptCount={(() => {
                    void receiptTick;
                    return sessionTempFilenamesRef.current.size;
                  })()}
                  onUpload={(path, meta) => {
                    registerTempUpload(path, meta);
                    setReceiptTick((t) => t + 1);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Shared bill for lines above the attachment threshold (same rules as single expenses).
                </p>
              </div>
            )}
            {submitProgress.status !== "idle" && (
              <div className="mt-4">
                <AsyncOperationProgress
                  status={submitProgress.status}
                  title={submitProgress.phase}
                  description={submitProgress.description}
                  currentStep={submitProgress.currentStep}
                  totalSteps={submitProgress.totalSteps}
                  showSuccess={submitProgress.status === "success"}
                />
              </div>
            )}
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={() => setStep(2)} disabled={loading}>
                <ChevronLeft className="mr-2 h-4 w-4" /> Back
              </Button>
              <Button onClick={() => void handleSubmit()} disabled={loading}>
                <Send className="mr-2 h-4 w-4" />
                {loading ? "Submitting…" : `Submit ${lines.length} expenses`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "results" && submitResult && (
        <Card>
          <CardHeader>
            <CardTitle>Submission results</CardTitle>
            <CardDescription>
              {submitResult.successCount} succeeded, {submitResult.failureCount} failed
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isMobile ? (
              <div className="space-y-3">
                {submitResult.results.map((r) => (
                  <div key={r.lineIndex} className="rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">Line {r.lineIndex + 1}</span>
                      {r.ok ? (
                        <Badge className="bg-green-100 text-green-800">Submitted</Badge>
                      ) : (
                        <span className="text-sm text-red-600">{r.error}</span>
                      )}
                    </div>
                    {r.transactionNumber && (
                      <p className="text-xs font-mono text-muted-foreground mt-1">
                        #{r.transactionNumber}
                      </p>
                    )}
                    {r.ok && r.expenseId && (
                      <div className="flex gap-2 mt-2">
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/expenses/${r.expenseId}`}>{t("batch.results.view")}</Link>
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/expenses/${r.expenseId}/edit`}>{t("batch.results.edit")}</Link>
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Txn #</TableHead>
                    <TableHead className="text-right">{t("batch.results.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {submitResult.results.map((r) => (
                    <TableRow key={r.lineIndex}>
                      <TableCell>{r.lineIndex + 1}</TableCell>
                      <TableCell>
                        {r.ok ? (
                          <Badge className="bg-green-100 text-green-800">Submitted</Badge>
                        ) : (
                          <span className="text-sm text-red-600">{r.error}</span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.transactionNumber || "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.ok && r.expenseId ? (
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" asChild>
                              <Link to={`/expenses/${r.expenseId}`}>{t("batch.results.view")}</Link>
                            </Button>
                            <Button variant="outline" size="sm" asChild>
                              <Link to={`/expenses/${r.expenseId}/edit`}>{t("batch.results.edit")}</Link>
                            </Button>
                          </div>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <Button className="w-full" onClick={() => navigate("/expenses")}>
              Back to my expenses
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
