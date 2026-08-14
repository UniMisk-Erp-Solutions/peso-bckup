import { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { useTranslation } from "@/i18n";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAllowCashierExpenseSubmission } from "@/hooks/useAllowCashierExpenseSubmission";
import { getOrgSettings } from "@/lib/orgSettingsCache";
import { blurFocusedNumberInputOnWheel } from "@/lib/numberInputWheel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CalendarIcon, Loader2, RotateCcw, Save, Send } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { formatINR, parseLocalDate } from "@/lib/format";
import { FileUpload } from "@/components/FileUpload";
import { ExpenseService, CreateExpenseData, UpdateExpenseData } from "@/services/ExpenseService";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import {
  getVisibleBranchIds,
  validateVisibleBranchFields,
} from "@/lib/conditionalFormFields";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";
import { z } from "zod";
import { DEFAULT_BASE_FIELD_CONFIG, resolveBaseFieldConfig, type BaseExpenseFieldKey, type BaseFieldConfig } from "@/lib/expenseFormConfig";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";
import { getDateLocale } from "@/lib/formatLocale";
import { canOwnerEditExpenseStatus } from "@/lib/expenseEditRules";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileExpenseFormLayout } from "@/components/mobile/MobileExpenseFormLayout";
import { MobileStickyActionBar } from "@/components/mobile/MobileStickyActionBar";
import { useOperationProgress } from "@/hooks/useOperationProgress";
import { AsyncOperationProgress } from "@/components/AsyncOperationProgress";
import { trackBaseFieldSelections, trackFormFieldSelections } from "@/lib/recommendedFormFieldOptions";
import { buildExpenseCustomFieldPayload } from "@/lib/expenseFormFieldPayload";
import {
  BatchExpenseContextCard,
  type BatchExpenseContextInfo,
  type BatchExpenseSibling,
} from "@/components/BatchExpenseContextCard";
import { ExpenseFormDraftBanner } from "@/components/ExpenseFormDraftBanner";
import { useExpenseFormDraft } from "@/hooks/useExpenseFormDraft";
import {
  expenseHasPersistedAttachments,
  recoverTempFilenamesFromAttachmentUrls,
  syncSessionTempFilenamesFromAttachments,
} from "@/lib/expenseAttachmentTempPaths";
import {
  saveExpenseFormDraft,
  type ExpenseFormDraft,
  type ExpenseFormDraftPayload,
  type ExpenseFormDraftScope,
} from "@/lib/expenseFormDraft";
import {
  saveExpenseSubmissionDraft,
} from "@/lib/expenseSubmissionDraftService";
import {
  saveBackupReceiptsToIndexedDB,
  reuploadBackupReceiptsFromIndexedDB,
} from "@/lib/expenseSubmittedBackupReceipts";
import {
  invokeFinalizeExpenseReceipts,
  runWithConcurrency,
  type ReceiptFinalizationResult,
  type FinalizeReceiptsInput,
} from "@/lib/receiptFinalization";
import {
  saveSubmittedExpenseBackup,
  submittedBackupToDraftPayload,
  type SubmittedExpenseBackup,
} from "@/lib/expenseSubmittedBackup";
// line items removed

// Line items schema removed

/** Parses storage object names under `temp/{userId}/…` from public receipt URLs (session uploads). */
function parseTempStorageNamesFromUrls(urls: string[] | undefined, userId: string): Set<string> {
  const names = new Set<string>();
  if (!urls?.length || !userId) return names;
  const needle = `/temp/${userId}/`;
  const needleLower = needle.toLowerCase();
  for (const url of urls) {
    const haystack = url.toLowerCase();
    const i = haystack.indexOf(needleLower);
    if (i === -1) continue;
    let path = url.slice(i + needle.length);
    const q = path.indexOf("?");
    if (q !== -1) path = path.slice(0, q);
    const hash = path.indexOf("#");
    if (hash !== -1) path = path.slice(0, hash);
    try {
      const decoded = decodeURIComponent(path);
      if (decoded) names.add(decoded);
    } catch {
      if (path) names.add(path);
    }
  }
  return names;
}

type SessionTempMeta = {
  filename: string;
  file_size: number;
  content_type: string;
};

function metadataForAttachmentInsert(
  storageName: string,
  listMetadata: Record<string, string | undefined> | undefined,
  sessionMeta: Map<string, SessionTempMeta>
) {
  const meta = listMetadata;
  const fallback = sessionMeta.get(storageName);
  const displayName =
    meta?.originalFilename ||
    meta?.originalfilename ||
    fallback?.filename ||
    storageName ||
    "unknown";
  const byteLength =
    (Number(meta?.uploadByteLength ?? meta?.size ?? 0) || 0) ||
    (fallback?.file_size ?? 0) ||
    0;
  const contentType = meta?.mimetype || fallback?.content_type || "image/jpeg";
  return {
    displayName,
    byteLength,
    contentType,
  };
}

export default function ExpenseForm() {
  const { t, i18n } = useTranslation(["expenses", "common"]);

  const expenseSchema = useMemo(
    () =>
      z.object({
        title: z.string().optional(),
        destination: z.string().optional(),
        expense_date: z.date().refine(
          (date) => {
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            return date <= today;
          },
          { message: t("form.validation.dateFuture") },
        ),
        purpose: z.string().optional(),
        amount: z.number().positive(t("form.validation.amountPositive")),
        category: z.string().min(1, t("form.validation.categoryRequired")),
      }),
    [t],
  );
  const {
    user,
    session,
    userProfile,
    userRole,
    organizationId,
    organizationFeatureFlags,
    loading: authLoading,
  } = useAuth();
  /** Survives brief auth refresh when navigating back to this page (session before user state). */
  const activeUserId = user?.id ?? session?.user?.id;
  const effectiveOrganizationId = organizationId ?? userProfile?.organization_id ?? null;
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;
  const baseFieldCustomizationEnabled =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization] === true;
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const resubmitBackupHandledRef = useRef(false);
  const { toast } = useToast();
  const { allowCashierExpenseSubmission, loading: settingLoading } = useAllowCashierExpenseSubmission();
  const { isMobile } = useViewportMode();

  // Block cashiers only when org does not allow cashier expense submission
  useEffect(() => {
    if (userRole !== "cashier") return;
    if (settingLoading) return;
    if (allowCashierExpenseSubmission === true) return;
    toast({
      variant: "destructive",
      title: t("form.accessDenied"),
      description: t("common:notAuthorized"),
    });
    navigate("/expenses");
  }, [userRole, allowCashierExpenseSubmission, settingLoading, navigate, toast]);

  const [loading, setLoading] = useState(false);
  const isSavingRef = useRef(false);
  const {
    progress: submitProgress,
    startOperation: startSubmitProgress,
    updateOperation: updateSubmitProgress,
    completeOperation: completeSubmitProgress,
    warnOperation: warnSubmitProgress,
    failOperation: failSubmitProgress,
    resetOperation: resetSubmitProgress,
  } = useOperationProgress({ showDelay: 300, successClear: 1800 });
  const [expense, setExpense] = useState({
    title: "",
    destination: "",
    expense_date: new Date(),
    purpose: "",
    amount: 0,
    category: "",
  });
  // Line items state removed
  const [isEditing, setIsEditing] = useState(false);
  const [expenseStatus, setExpenseStatus] = useState<string | null>(null);
  const [batchInfo, setBatchInfo] = useState<BatchExpenseContextInfo | null>(null);
  const [batchSiblings, setBatchSiblings] = useState<BatchExpenseSibling[]>([]);
  /** Temp bucket object names uploaded during this form session (avoids moving stale temp files on submit). */
  const sessionTempFilenamesRef = useRef<Set<string>>(new Set());
  /** Display name + size per temp object (used when Storage list() fails with 544/timeout). */
  const sessionTempUploadMetaRef = useRef<Map<string, SessionTempMeta>>(new Map());
  /** Maps uploaded public URL → temp bucket filename for submit finalization. */
  const tempStoragePathByUrlRef = useRef<Map<string, string>>(new Map());
  /** URLs already saved as attachment rows in the DB (loaded by fetchExpense in edit mode).
   *  moveTempFilesToExpense must not re-process these — the row already exists. */
  const persistedAttachmentUrlsRef = useRef<Set<string>>(new Set());
  /** Finalization results from the most-recent moveTempFilesToExpense call.
   *  Read by persistSubmittedSafetyCopy so backup uses confirmed paths, not stale temp URLs. */
  const finalizationResultsRef = useRef<ReceiptFinalizationResult[]>([]);
  /** In-memory blob cache: bare filename → File/Blob captured at upload time.
   *  Passed to invokeFinalizeExpenseReceipts so backup has zero post-submit network calls. */
  const sessionBlobCacheRef = useRef<Map<string, Blob>>(new Map());
  const draftScope = useMemo<ExpenseFormDraftScope>(
    () => (id && id !== "new" ? id : "new"),
    [id],
  );
  const isEditRoute = Boolean(id && id !== "new");
  const [requiredFiles, setRequiredFiles] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);
  const [categorySearchTerm, setCategorySearchTerm] = useState("");
  const [recommendedCategories, setRecommendedCategories] = useState<string[]>([]);
  const [showRecommended, setShowRecommended] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [addCatOpen, setAddCatOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [attachmentRequiredAboveAmount, setAttachmentRequiredAboveAmount] = useState<number>(50); // Default ₹50
  const [isAttachmentRequired, setIsAttachmentRequired] = useState(false);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [fileUploadResetKey, setFileUploadResetKey] = useState(0);

  // Form fields state
  const [categoryFormFields, setCategoryFormFields] = useState<any[]>([]);
  const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({});
  const [optionBranches, setOptionBranches] = useState<OptionBranchDefinition[]>([]);
  const [branchValues, setBranchValues] = useState<Record<string, string>>({});
  const [baseFieldConfig, setBaseFieldConfig] = useState<Record<BaseExpenseFieldKey, BaseFieldConfig>>(DEFAULT_BASE_FIELD_CONFIG);

  /** Latest form values — updated every render so picker/pagehide never saves stale closures. */
  const formStateRef = useRef({
    expense: {
      title: "",
      destination: "",
      expense_date: new Date(),
      purpose: "",
      amount: 0,
      category: "",
    },
    formFieldValues: {} as Record<string, string>,
    branchValues: {} as Record<string, string>,
    attachments: [] as string[],
  });

  formStateRef.current = {
    expense,
    formFieldValues,
    branchValues,
    attachments,
  };

  const translatedBaseFields = useMemo(
    () => translateBaseFieldConfig(baseFieldConfig, t),
    [baseFieldConfig, t, i18n.language],
  );

  const getBaseField = (key: BaseExpenseFieldKey): BaseFieldConfig =>
    translatedBaseFields[key] ||
    translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, t)[key];

  const fetchBaseFieldConfig = async () => {
    try {
      if (!effectiveOrganizationId) return;
      const { data, error } = await (supabase as any)
        .from("organization_expense_form_fields")
        .select("*")
        .eq("organization_id", effectiveOrganizationId);
      if (!error && data) {
        setBaseFieldConfig(resolveBaseFieldConfig(data as Partial<BaseFieldConfig>[]));
      }
    } catch (e) {
      console.warn("Unable to load organization_expense_form_fields, using defaults");
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        setLoadingCategories(true);
        if (!effectiveOrganizationId) return;

        // Try with 'active' first, then 'is_active' (filtered by organization_id)
        let { data: catData, error: catError } = await supabase
          .from('expense_categories')
          .select('name, active')
          .eq('organization_id', effectiveOrganizationId)
          .eq('active', true)
          .order('name');

        if (catError && (catError as any).code === '42703') {
          // Fallback to 'is_active'
          const res2 = await supabase
            .from('expense_categories')
            .select('name, is_active')
            .eq('organization_id', effectiveOrganizationId)
            .eq('is_active', true)
            .order('name');
          catData = res2.data;
          catError = res2.error;
        }

        if (catData) {
          const categoryNames = catData.map((c: any) => c.name || c);
          setCategories(categoryNames);
        }

        if (activeUserId) {
          const { data: role } = await supabase
            .from('user_roles')
            .select('role')
            .eq('user_id', activeUserId)
            .eq('role', 'admin')
            .maybeSingle();
          setIsAdmin(!!role);
        }

        // Fetch attachment required above amount — shared cache, no extra round-trip
        const orgSettingsData = await getOrgSettings(effectiveOrganizationId);
        if (
          orgSettingsData?.attachment_required_above_amount !== null &&
          orgSettingsData?.attachment_required_above_amount !== undefined
        ) {
          const limit = Number(orgSettingsData.attachment_required_above_amount);
          if (!isNaN(limit) && limit >= 0) {
            setAttachmentRequiredAboveAmount(limit);
          }
        } else {
          // Fallback to settings table with organization_id filter
          const { data: attachmentLimitSetting, error: settingsError } = await supabase
            .from('settings')
            .select('value')
            .eq('key', 'attachment_required_above_amount')
            .eq('organization_id', effectiveOrganizationId)
            .maybeSingle();

          if (!settingsError && attachmentLimitSetting) {
            const limit = parseFloat(attachmentLimitSetting.value);
            if (!isNaN(limit) && limit >= 0) {
              setAttachmentRequiredAboveAmount(limit);
            }
          }
        }
      } finally {
        setLoadingCategories(false);
      }
    };
    init();
    fetchBaseFieldConfig();
    if (id && id !== "new") {
      fetchExpense();
      setIsEditing(true);
    }
  }, [id, effectiveOrganizationId]);

  // Fetch form fields for selected category
  const fetchCategoryFormFields = async (
    categoryName: string,
    options?: {
      preserveFormValues?: Record<string, string>;
      preserveBranchValues?: Record<string, string>;
    },
  ) => {
    try {
      if (!organizationId || !categoryName) {
        setCategoryFormFields([]);
        setFormFieldValues({});
        return;
      }

      // Get category ID
      let { data: categoryData } = await supabase
        .from("expense_categories")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("name", categoryName)
        .maybeSingle();

      if (!categoryData) {
        setCategoryFormFields([]);
        setFormFieldValues({});
        return;
      }

      // Get form field assignments for this category
      const { data: assignments, error } = await supabase
        .from("expense_category_form_fields")
        .select(`
          *,
          expense_form_field_templates(*)
        `)
        .eq("organization_id", organizationId)
        .eq("category_id", categoryData.id)
        .order("display_order", { ascending: true });

      if (error) throw error;

      const fields = (assignments || []).map((assignment: any) => ({
        ...assignment,
        template: assignment.expense_form_field_templates
      })).filter((assignment: any) => {
        const submitFlag = assignment.show_on_submit;
        const templateSubmitFlag = assignment.template?.show_on_submit;
        return (submitFlag ?? templateSubmitFlag ?? true) === true;
      });

      setCategoryFormFields(fields);

      if (allowConditionalDropdown && organizationId) {
        const selectIds = fields
          .map((f: any) => f.template)
          .filter((t: any) => t?.field_type === "select")
          .map((t: any) => t.id);
        const branches = await ExpenseService.fetchOptionBranchesForTemplates(
          organizationId,
          selectIds,
        );
        setOptionBranches(branches);
        if (options?.preserveBranchValues) {
          setBranchValues(options.preserveBranchValues);
        } else {
          setBranchValues({});
        }
      } else {
        setOptionBranches([]);
        if (options?.preserveBranchValues) {
          setBranchValues(options.preserveBranchValues);
        } else {
          setBranchValues({});
        }
      }

      if (options?.preserveFormValues) {
        setFormFieldValues(options.preserveFormValues);
        return;
      }

      const initialValues: Record<string, string> = {};
      fields.forEach((field: any) => {
        if (field.template?.default_value) {
          initialValues[field.template.id] = field.template.default_value;
        } else if (field.template?.field_type === 'checkbox') {
          initialValues[field.template.id] = 'false';
        }
      });
      setFormFieldValues(initialValues);
    } catch (e: any) {
      console.error("Failed to fetch category form fields:", e);
      setCategoryFormFields([]);
    }
  };

  // Always points to the latest fetchCategoryFormFields (with current organizationId).
  // applyExpenseDraftFromStorage only deps on activeUserId, so without this ref it would
  // close over a stale fetchCategoryFormFields from before organizationId was loaded,
  // causing the null-org guard to fire and wipe formFieldValues on every draft restore.
  const fetchCategoryFormFieldsRef = useRef(fetchCategoryFormFields);
  fetchCategoryFormFieldsRef.current = fetchCategoryFormFields;

  const buildDraftPayloadFromRef = useCallback((): ExpenseFormDraftPayload => {
    const snap = formStateRef.current;
    return {
      expense: {
        title: snap.expense.title,
        destination: snap.expense.destination,
        expense_date: snap.expense.expense_date.toISOString(),
        purpose: snap.expense.purpose,
        amount: snap.expense.amount,
        category: snap.expense.category,
      },
      formFieldValues: { ...snap.formFieldValues },
      branchValues: { ...snap.branchValues },
      attachments: [...snap.attachments],
      sessionTempFilenames: Array.from(sessionTempFilenamesRef.current),
      sessionTempMeta: Array.from(sessionTempUploadMetaRef.current.entries()).map(([path, meta]) => ({
        path,
        ...meta,
      })),
    };
  }, []);

  const applyExpenseDraftFromStorage = useCallback((draft: ExpenseFormDraft) => {
    const parsedDate = new Date(draft.expense.expense_date);
    const nextExpense = {
      title: draft.expense.title,
      destination: draft.expense.destination,
      expense_date: Number.isFinite(parsedDate.getTime()) ? parsedDate : new Date(),
      purpose: draft.expense.purpose,
      amount: Number.isFinite(Number(draft.expense.amount)) ? draft.expense.amount : 0,
      category: draft.expense.category,
    };
    formStateRef.current = {
      expense: nextExpense,
      formFieldValues: { ...draft.formFieldValues },
      branchValues: { ...draft.branchValues },
      attachments: [...draft.attachments],
    };
    setExpense(nextExpense);
    setAttachments(draft.attachments);
    setFormFieldValues(draft.formFieldValues);
    setBranchValues(draft.branchValues);
    sessionTempFilenamesRef.current = new Set(draft.sessionTempFilenames);
    sessionTempUploadMetaRef.current = new Map(
      draft.sessionTempMeta.map((m) => [
        m.path,
        {
          filename: m.filename,
          file_size: m.file_size,
          content_type: m.content_type,
        },
      ]),
    );
    if (activeUserId) {
      recoverTempFilenamesFromAttachmentUrls(
        activeUserId,
        draft.attachments,
        sessionTempFilenamesRef.current,
      );
    }

    if (draft.expense.category) {
      void fetchCategoryFormFieldsRef.current(draft.expense.category, {
        preserveFormValues: draft.formFieldValues,
        preserveBranchValues: draft.branchValues,
      });
    }
  }, [activeUserId]);

  const persistSubmittedSafetyCopy = useCallback(
    (
      expenseId: string | null | undefined,
      submissionStatus: "submitted" | "draft",
    ) => {
      if (!activeUserId || !effectiveOrganizationId) return;
      const payload = buildDraftPayloadFromRef();
      const localResult = saveSubmittedExpenseBackup(activeUserId, effectiveOrganizationId, {
        expenseId,
        submissionStatus,
        payload,
      });
      if (localResult.ok && localResult.localId && localResult.expiresAt) {
        void saveBackupReceiptsToIndexedDB({
          userId: activeUserId,
          organizationId: effectiveOrganizationId,
          backupLocalId: localResult.localId,
          expiresAt: localResult.expiresAt,
          payload,
          finalizationResults: finalizationResultsRef.current.length > 0
            ? [...finalizationResultsRef.current]
            : undefined,
        }).catch((err) => {
          console.warn("Could not save receipt copies to browser storage:", err);
        });
      }
      void saveExpenseSubmissionDraft(supabase, {
        userId: activeUserId,
        organizationId: effectiveOrganizationId,
        expenseId,
        submissionStatus,
        payload,
      }).catch((err) => {
        console.warn("Could not save submission draft to database:", err);
      });
    },
    [activeUserId, effectiveOrganizationId, buildDraftPayloadFromRef],
  );

  const {
    formReady,
    draftNotice,
    persistDraft,
    restoreDraftIfAny,
    clearDraft,
    finalizeAfterSubmit,
    clearDraftForManualReset,
    completeEditBootstrap,
  } = useExpenseFormDraft({
    userId: activeUserId,
    organizationId: effectiveOrganizationId,
    scope: draftScope,
    isEditRoute,
    getPayload: buildDraftPayloadFromRef,
    applyDraft: applyExpenseDraftFromStorage,
    autosaveDeps: [expense, formFieldValues, branchValues, attachments],
  });

  useLayoutEffect(() => {
    if (isEditRoute || resubmitBackupHandledRef.current) return;
    const backup = (location.state as { resubmitFromBackup?: SubmittedExpenseBackup } | null)
      ?.resubmitFromBackup;
    if (!backup || !activeUserId || !effectiveOrganizationId) return;

    resubmitBackupHandledRef.current = true;
    const draftFromBackup: ExpenseFormDraft = {
      v: 2,
      savedAt: backup.savedAt,
      pendingSubmit: true,
      ...submittedBackupToDraftPayload(backup),
    };
    applyExpenseDraftFromStorage(draftFromBackup);

    void (async () => {
      const restored = await reuploadBackupReceiptsFromIndexedDB(
        supabase,
        activeUserId,
        effectiveOrganizationId,
        backup.localId,
      );
      if (restored.length === 0) return;

      const urls = restored.map((r) => r.file_url);
      sessionTempFilenamesRef.current = new Set(restored.map((r) => r.storage_path));
      sessionTempUploadMetaRef.current = new Map(
        restored.map((r) => [
          r.storage_path,
          {
            filename: r.filename,
            file_size: r.file_size,
            content_type: r.content_type,
          },
        ]),
      );
      tempStoragePathByUrlRef.current = new Map(
        restored.map((r) => [r.file_url, r.storage_path]),
      );
      formStateRef.current = {
        ...formStateRef.current,
        attachments: urls,
      };
      setAttachments(urls);
      setFileUploadResetKey((k) => k + 1);
    })();

    toast({
      title: t("localBackups.restoredTitle"),
      description: t("localBackups.restoredDescription"),
    });
    window.history.replaceState({}, document.title);
  }, [
    isEditRoute,
    location.state,
    activeUserId,
    effectiveOrganizationId,
    applyExpenseDraftFromStorage,
    toast,
    t,
  ]);

  /** Synchronous save using latest ref (before camera / file picker). */
  const flushExpenseDraftNow = useCallback(() => {
    if (!activeUserId || !effectiveOrganizationId) return;
    saveExpenseFormDraft(
      activeUserId,
      effectiveOrganizationId,
      buildDraftPayloadFromRef(),
      draftScope,
      { force: true },
    );
    persistDraft({ force: true });
  }, [activeUserId, effectiveOrganizationId, draftScope, buildDraftPayloadFromRef, persistDraft]);

  const createDefaultExpenseState = useCallback(
    () => ({
      title: "",
      destination: "",
      expense_date: new Date(),
      purpose: "",
      amount: 0,
      category: "",
    }),
    [],
  );

  const deleteSessionTempUploads = useCallback(async () => {
    if (!user?.id) return;
    const files = Array.from(sessionTempFilenamesRef.current);
    if (files.length === 0) return;
    // DOC-078: staging copies are RETAINED, not deleted. temp/{userId}/{file} is the
    // only second copy a receipt has until the archive tier exists — deleting it here
    // is what leaves a receipt single-copy (DOC-077 §5d). Local tracking is cleared;
    // reclaiming staging bytes is a separate, server-side retention job.
    sessionTempFilenamesRef.current.clear();
    sessionTempUploadMetaRef.current.clear();
    tempStoragePathByUrlRef.current.clear();
  }, [user?.id]);

  const resetExpenseFormState = useCallback(() => {
    const defaults = createDefaultExpenseState();
    setExpense(defaults);
    setAttachments([]);
    setFormFieldValues({});
    setBranchValues({});
    setCategoryFormFields([]);
    setOptionBranches([]);
    setCategorySearchTerm("");
    formStateRef.current = {
      expense: defaults,
      formFieldValues: {},
      branchValues: {},
      attachments: [],
    };
    persistedAttachmentUrlsRef.current.clear();
    setFileUploadResetKey((key) => key + 1);
  }, [createDefaultExpenseState]);

  const handleClearForm = useCallback(async () => {
    if (loading) return;
    try {
      await deleteSessionTempUploads();
      clearDraftForManualReset();
      if (isEditing && id) {
        setAttachments([]);
        setFileUploadResetKey((key) => key + 1);
        await fetchExpense({ skipDraftRestore: true });
      } else {
        resetExpenseFormState();
      }
      toast({
        title: t("form.clearFormDone"),
        description: isEditing
          ? t("form.clearFormDoneEdit")
          : t("form.clearFormDoneNew"),
      });
    } catch (err) {
      console.error("Failed to clear expense form:", err);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: t("form.clearFormFailed"),
      });
    }
  }, [
    loading,
    deleteSessionTempUploads,
    clearDraftForManualReset,
    isEditing,
    id,
    resetExpenseFormState,
    toast,
    t,
  ]);

  /** Discard browser cache and leave the form (submit clears cache in saveExpense). */
  const handleCancelForm = useCallback(() => {
    if (activeUserId && effectiveOrganizationId) {
      finalizeAfterSubmit();
    }
    navigate("/expenses");
  }, [activeUserId, effectiveOrganizationId, finalizeAfterSubmit, navigate]);

  // Update attachment requirement based on amount
  useEffect(() => {
    const amount = expense.amount || 0;
    const required = amount > attachmentRequiredAboveAmount;
    setIsAttachmentRequired(required);

    // If amount is below limit and attachments exist, clear them (optional - you may want to keep existing)
    // For now, we'll just disable the field but keep existing attachments
  }, [expense.amount, attachmentRequiredAboveAmount]);

  const fetchExpense = async (options?: { skipDraftRestore?: boolean }) => {
    try {
      const { data: expenseData, error: expenseError } = await supabase
        .from("expenses")
        .select("*")
        .eq("id", id)
        .single();

      if (expenseError) throw expenseError;

      const loadedExpense = {
        title: expenseData.title,
        destination: expenseData.destination,
        expense_date: parseLocalDate(expenseData.trip_start) ?? new Date(),
        purpose: expenseData.purpose || "",
        amount: Number(expenseData.total_amount || 0),
        category: expenseData.category || "",
      };
      setExpense(loadedExpense);
      formStateRef.current = {
        ...formStateRef.current,
        expense: loadedExpense,
      };

      setExpenseStatus(expenseData.status);

      if (expenseData.batch_id && organizationId) {
        const { data: batchRow } = await supabase
          .from("expense_batches")
          .select("id, label, line_count, total_amount, created_at")
          .eq("id", expenseData.batch_id)
          .eq("organization_id", organizationId)
          .maybeSingle();

        if (batchRow) {
          setBatchInfo(batchRow);
        } else {
          setBatchInfo(null);
        }

        const { data: siblings } = await supabase
          .from("expenses")
          .select("id, title, total_amount, status, transaction_number")
          .eq("batch_id", expenseData.batch_id)
          .eq("organization_id", organizationId)
          .order("created_at", { ascending: true });

        setBatchSiblings(
          (siblings || []).map((row) => ({
            ...row,
            total_amount: Number(row.total_amount),
          })),
        );
      } else {
        setBatchInfo(null);
        setBatchSiblings([]);
      }

      if (
        id &&
        user?.id &&
        expenseData.user_id === user.id &&
        !canOwnerEditExpenseStatus(expenseData.status)
      ) {
        toast({
          variant: "destructive",
          title: t("form.cannotEdit"),
          description:
            expenseData.status === "approved" || expenseData.status === "paid"
              ? t("form.cannotEditApproved")
              : t("form.cannotEditStatus"),
        });
        navigate(`/expenses/${id}`);
        return;
      }

      if (
        id &&
        user?.id &&
        expenseData.user_id === user.id &&
        expenseData.status === "edited"
      ) {
        toast({
          title: t("form.adjustedByOrg"),
          description: t("form.adjustedByOrgHint"),
        });
        navigate(`/expenses/${id}`);
        return;
      }

      // Fetch form fields for this category and load existing values
      if (expenseData.category) {
        await fetchCategoryFormFields(expenseData.category);

        // Load existing form field values (with org filter, then without for legacy rows)
        let existingValues: { template_id: string | null; field_value: string }[] | null = null;
        const withOrg = await supabase
          .from("expense_form_field_values")
          .select("template_id, field_value")
          .eq("expense_id", expenseData.id)
          .eq("organization_id", organizationId);

        if (!withOrg.error && withOrg.data?.length) {
          existingValues = withOrg.data;
        } else {
          const withoutOrg = await supabase
            .from("expense_form_field_values")
            .select("template_id, field_value")
            .eq("expense_id", expenseData.id);
          if (!withoutOrg.error && withoutOrg.data) {
            existingValues = withoutOrg.data;
          }
        }

        if (existingValues) {
          const values: Record<string, string> = {};
          existingValues.forEach((val: any) => {
            if (val.template_id) values[val.template_id] = val.field_value;
          });
          setFormFieldValues(values);
        }
        if (allowConditionalDropdown && organizationId && expenseData.id) {
          const loaded = await ExpenseService.loadBranchFieldValuesForExpense(
            expenseData.id,
            organizationId,
          );
          setBranchValues(loaded);
        }
      }

      // Fetch existing attachments for this expense
      const { data: attachmentsData, error: attachmentsError } = await supabase
        .from("attachments")
        .select("file_url, storage_path, filename, content_type, file_size")
        .eq("expense_id", id)
        .eq("organization_id", expenseData.organization_id);

      if (!attachmentsError && attachmentsData && attachmentsData.length > 0) {
        const existingAttachmentUrls = attachmentsData
          .map(att => att.file_url)
          .filter((url): url is string => Boolean(url));
        setAttachments(existingAttachmentUrls);
        // Record these as persisted so moveTempFilesToExpense skips them — they already have DB rows.
        persistedAttachmentUrlsRef.current.clear();
        for (const url of existingAttachmentUrls) {
          persistedAttachmentUrlsRef.current.add(url);
        }
        for (const att of attachmentsData) {
          const storagePath = (att.storage_path as string | null) || null;
          const fileUrl = att.file_url as string | null;
          if (storagePath && fileUrl) {
            tempStoragePathByUrlRef.current.set(fileUrl, storagePath);
          }
        }
      }

      // no line items fetch
    } catch (error) {
      console.error("Error fetching expense:", error);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: t("form.loadFailed"),
      });
    } finally {
      if (isEditRoute) {
        if (!options?.skipDraftRestore) {
          restoreDraftIfAny({ showNotice: true });
        }
        completeEditBootstrap();
      }
    }
  };

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    if (!organizationId) {
      toast({ variant: 'destructive', title: t('common:error'), description: t('form.toast.orgNotFound') });
      return;
    }
    try {
      // Try inserting with 'active' first (must include organization_id)
      let { error } = await supabase
        .from('expense_categories')
        .insert({ name, active: true, organization_id: organizationId, created_by: user?.id || null });
      if (error && (error as any).code === '42703') {
        // Fallback to 'is_active'
        const res2 = await supabase
          .from('expense_categories')
          .insert({ name, is_active: true, organization_id: organizationId, created_by: user?.id || null });
        error = res2.error as any;
      }
      if (error) throw error;

      // Refresh categories list
      setCategories((prev) => Array.from(new Set([...
        prev,
        name
      ])));
      setNewCategoryName("");
      setAddCatOpen(false);
      toast({ title: t('form.toast.categoryAdded'), description: t('form.toast.categoryAddedHint', { name }) });
    } catch (e: any) {
      console.error('Failed to add category:', e);
      toast({ variant: 'destructive', title: t('common:error'), description: e?.message || t('form.toast.addCategoryFailed') });
    }
  };

  const AddCategoryDialog = (
    <Dialog open={addCatOpen} onOpenChange={setAddCatOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("form.addCategoryTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="newCat">{t("form.fields.category")}</Label>
          <Input
            id="newCat"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder={t("form.placeholders.newCategory")}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setAddCatOpen(false)}>{t("common:cancel")}</Button>
          <Button onClick={handleAddCategory} disabled={!newCategoryName.trim()}>{t("common:save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // addLineItem removed

  const moveTempFilesToExpense = async (
    expenseId: string,
    options?: { requireAtLeastOne?: boolean; attachmentUrls?: string[] },
  ) => {
    // IMPORTANT: do NOT scan/list `temp/${userId}` here.
    // Large tenants can have huge temp history; storage list() can time out.
    // We only move the exact temp objects recorded during this form session.
    if (!user?.id) return;
    if (!organizationId) throw new Error("Organization not found");

    const allAttachmentUrls = [
      ...formStateRef.current.attachments,
      ...(options?.attachmentUrls ?? attachments),
    ];

    // Only expand from URLs that weren't already saved as DB attachment rows.
    // Persisted-URL attachments already have rows — re-processing them tries to move
    // files that no longer exist at temp and then inserts duplicate rows.
    const freshAttachmentUrls = allAttachmentUrls.filter(
      (url) => !persistedAttachmentUrlsRef.current.has(url),
    );
    syncSessionTempFilenamesFromAttachments(
      user.id,
      freshAttachmentUrls,
      sessionTempFilenamesRef.current,
    );
    for (const name of parseTempStorageNamesFromUrls(freshAttachmentUrls, user.id)) {
      sessionTempFilenamesRef.current.add(name);
    }
    for (const url of freshAttachmentUrls) {
      const mapped = tempStoragePathByUrlRef.current.get(url);
      if (mapped) sessionTempFilenamesRef.current.add(mapped);
    }

    const startedAt = performance.now();
    const tempFileNames = Array.from(sessionTempFilenamesRef.current);
    if (tempFileNames.length === 0) {
      if (options?.requireAtLeastOne) {
        const hasExisting = await expenseHasPersistedAttachments(expenseId, organizationId);
        if (hasExisting) return;

        const hadAttachmentUrls = allAttachmentUrls.some(Boolean);
        throw new Error(
          hadAttachmentUrls
            ? "Bill photos could not be linked to this expense. Please re-upload your receipts and try again."
            : "Bill photos are required for this expense. Please upload at least one receipt and try again.",
        );
      }
      return;
    }

    // Build receipt list for the Edge Function.
    const receipts: FinalizeReceiptsInput[] = tempFileNames
      .filter(Boolean)
      .map((fileName) => {
        const meta = sessionTempUploadMetaRef.current.get(fileName);
        return {
          filename: fileName,
          contentType: meta?.content_type || "image/jpeg",
          fileSize: meta?.file_size || 0,
        };
      });

    // Invoke the edge function — server-side download → upload → download-verify.
    // No browser-side storage.move / copy / createSignedUrl / download calls.
    const allResults = await invokeFinalizeExpenseReceipts(supabase, {
      expenseId,
      userId: user.id,
      receipts,
      blobCache: sessionBlobCacheRef.current,
    });

    // Insert DB attachment rows for each successfully finalized/fallback file.
    const insertTasks = allResults.map(
      (result) => async (): Promise<ReceiptFinalizationResult | null> => {
        if (result.status === "failed") return result;

        const meta = sessionTempUploadMetaRef.current.get(result.filename);
        const filename = meta?.filename || result.filename;
        const contentType = meta?.content_type || "image/jpeg";
        const fileSize = Number.isFinite(meta?.file_size) ? (meta?.file_size as number) : 0;

        const { error: attachmentInsertError } = await supabase
          .from("attachments")
          .insert({
            expense_id: expenseId,
            organization_id: organizationId,
            file_url: result.fileUrl || "",
            filename,
            content_type: contentType,
            uploaded_by: user.id,
            file_size: fileSize > 0 ? fileSize : null,
            storage_path: result.resolvedPath,
          });

        if (attachmentInsertError) {
          console.error("[moveTempFilesToExpense] attachment insert error", {
            fileName: result.filename,
            resolvedPath: result.resolvedPath,
            attachmentInsertError,
          });
          return { ...result, status: "failed" as const, resolvedPath: null };
        }

        return result;
      },
    );

    const perFileResults = await runWithConcurrency(insertTasks, 2);
    const validResults = perFileResults.filter((r): r is ReceiptFinalizationResult => r != null);
    finalizationResultsRef.current = validResults;

    const movedCount = validResults.filter((r) => r.status === "finalized").length;
    const tempFallbackCount = validResults.filter((r) => r.status === "temporary_fallback").length;
    const failedCount = validResults.filter((r) => r.status === "failed").length;

    console.info("[moveTempFilesToExpense] done", {
      durationMs: Math.round(performance.now() - startedAt),
      tempCount: tempFileNames.length,
      movedCount,
      tempFallbackCount,
      failedCount,
      expenseId,
    });

    if (tempFallbackCount > 0) {
      toast({
        title: t("expenses:form.submitSuccess"),
        description: t("expenses:form.receiptsTempFallback", {
          defaultValue: "Some receipts are temporarily stored and will be finalized later.",
        }),
      });
    }

    if (movedCount === 0 && tempFallbackCount === 0 && tempFileNames.length > 0) {
      throw new Error("Failed to attach uploaded bill photos. Please re-upload and try again.");
    }
  };

  // Fetch recommended categories based on usage
  const fetchRecommendedCategories = async () => {
    try {
      if (!organizationId || !user?.id || categories.length === 0) {
        // If no categories yet, set default recommendations
        if (categories.length > 0) {
          setRecommendedCategories(categories.slice(0, 3));
        }
        return;
      }

      const { data, error } = await supabase
        .from("category_usage_tracking")
        .select("category_name, usage_count")
        .eq("organization_id", organizationId)
        .eq("user_id", user.id)
        .order("usage_count", { ascending: false })
        .order("last_used_at", { ascending: false })
        .limit(4);

      if (error) {
        console.error("Failed to fetch recommended categories:", error);
      }

      let recommended: string[] = [];

      if (data && data.length > 0) {
        // User has usage history - use their top categories
        recommended = (data || [])
          .map(item => item.category_name)
          .filter(name => categories.includes(name)); // Only include active categories
      }

      // If user has no history or less than 3 recommendations, fill with default/common categories
      if (recommended.length < 3 && categories.length > 0) {
        // Common categories that are likely to be used
        const commonCategories = ["Travel", "Food", "Office Supplies", "Transport", "Meals", "Fuel", "Accommodation"];

        // Get categories that aren't already in recommended
        const availableCategories = categories.filter(cat =>
          !recommended.includes(cat) &&
          commonCategories.some(common => cat.toLowerCase().includes(common.toLowerCase()))
        );

        // Fill up to 3 total recommendations
        const needed = 3 - recommended.length;
        recommended = [...recommended, ...availableCategories.slice(0, needed)];

        // If still not enough, just add any available categories
        if (recommended.length < 3) {
          const remaining = categories.filter(cat => !recommended.includes(cat));
          recommended = [...recommended, ...remaining.slice(0, 3 - recommended.length)];
        }
      }

      setRecommendedCategories(recommended.slice(0, 4)); // Max 4 recommendations
    } catch (e: any) {
      console.error("Error fetching recommended categories:", e);
      // Fallback: use first 3 categories if available
      if (categories.length > 0) {
        setRecommendedCategories(categories.slice(0, 3));
      }
    }
  };

  // Fetch recommended categories when categories change
  useEffect(() => {
    if (categories.length > 0 && organizationId && user?.id) {
      fetchRecommendedCategories();
    }
  }, [categories.length, organizationId, user?.id]);

  // Track category usage
  const trackCategoryUsage = async (categoryName: string) => {
    try {
      if (!organizationId || !user?.id || !categoryName) return;

      // Try RPC function first
      const { error: rpcError } = await supabase.rpc('increment_category_usage', {
        p_organization_id: organizationId,
        p_user_id: user.id,
        p_category_name: categoryName
      });

      if (rpcError) {
        // Fallback to direct upsert with increment
        const { data: existing } = await supabase
          .from("category_usage_tracking")
          .select("usage_count")
          .eq("organization_id", organizationId)
          .eq("user_id", user.id)
          .eq("category_name", categoryName)
          .maybeSingle();

        const newCount = existing ? existing.usage_count + 1 : 1;

        const { error: upsertError } = await supabase
          .from("category_usage_tracking")
          .upsert({
            organization_id: organizationId,
            user_id: user.id,
            category_name: categoryName,
            usage_count: newCount,
            last_used_at: new Date().toISOString()
          }, {
            onConflict: 'organization_id,user_id,category_name'
          });

        if (upsertError) {
          console.error("Failed to track category usage:", upsertError);
        }
      }

      // Refresh recommended categories
      await fetchRecommendedCategories();
    } catch (e: any) {
      console.error("Error tracking category usage:", e);
    }
  };

  // Save custom form field values via the atomic replace RPC.
  // Throws on failure so the overall submit/update aborts (no false success).
  const saveFormFieldValues = async (expenseId: string) => {
    if (!organizationId) {
      throw new Error(
        "Your expense was not saved because the additional information could not be stored. Please try again.",
      );
    }

    // Nothing configured for this category: nothing to save or clear.
    if (categoryFormFields.length === 0 && optionBranches.length === 0) {
      return;
    }

    const visibleBranchIds =
      allowConditionalDropdown && optionBranches.length > 0
        ? getVisibleBranchIds(
          optionBranches,
          formFieldValues,
          branchValues,
          allowNestedConditional,
        )
        : new Set<string>();

    // One combined payload (regular template + conditional branch values).
    // The RPC replaces the full saved set atomically, so cleared/hidden fields
    // disappear and "0"/"false" are preserved.
    const payload = buildExpenseCustomFieldPayload({
      templateValues: formFieldValues,
      branchValues,
      visibleBranchIds,
    });

    try {
      await ExpenseService.replaceExpenseFormFieldValues(
        expenseId,
        organizationId,
        payload,
      );
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string } | null;
      console.error("[ExpenseForm] custom-field save failed", {
        expenseId,
        organizationId,
        code: err?.code,
        message: err?.message,
      });
      throw new Error(
        "Your expense was not saved because the additional information could not be stored. Please try again.",
      );
    }

    // Best-effort analytics — fire-and-forget so save is never blocked.
    if (user?.id) {
      void (async () => {
        try {
          const templateSelects = categoryFormFields
            .filter((f) => f.template?.field_type === "select")
            .map((f) => ({
              templateId: f.template.id,
              value: formFieldValues[f.template.id] || "",
            }))
            .filter((x) => x.value.trim());
          const branchSelects = optionBranches
            .filter((b) => b.field_type === "select")
            .map((b) => ({
              branchId: b.id,
              value: branchValues[b.id] || "",
            }))
            .filter((x) => x.value.trim());
          await trackFormFieldSelections(organizationId, user.id, {
            templateSelects,
            branchSelects,
          });
          if (baseFieldCustomizationEnabled) {
            await trackBaseFieldSelections(
              organizationId,
              user.id,
              (Object.keys(baseFieldConfig) as BaseExpenseFieldKey[]).map((k) => ({
                field_key: baseFieldConfig[k].field_key,
                input_type: baseFieldConfig[k].input_type,
              })),
              {
                category: expense.category,
                title: expense.title,
                destination: expense.destination,
                purpose: expense.purpose,
                amount: expense.amount ? String(expense.amount) : "",
                expense_date: expense.expense_date
                  ? format(expense.expense_date, "yyyy-MM-dd")
                  : "",
              },
            );
          }
        } catch (trackErr) {
          console.warn("trackFormFieldSelections failed (non-fatal):", trackErr);
        }
      })();
    }
  };

  // line item handlers removed

  const enforceMaxAttachmentSize = async (expenseId: string) => {
    if (!organizationId) return;
    const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB combined limit

    const { data: existingAttachments, error } = await supabase
      .from("attachments")
      .select("file_size")
      .eq("expense_id", expenseId)
      .eq("organization_id", organizationId);

    if (error) {
      throw new Error("Failed to validate total attachment size. Please try again.");
    }

    const totalBytes = (existingAttachments || []).reduce((sum: number, item: any) => {
      const size = Number(item?.file_size || 0);
      return sum + (Number.isFinite(size) ? size : 0);
    }, 0);

    if (totalBytes > MAX_TOTAL_SIZE) {
      const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
      throw new Error(`Total attachment size is ${totalMB}MB, which exceeds the 50MB limit. Please remove some files and try again.`);
    }
  };

  const saveExpense = async () => {
    if (!user) return;
    if (isSavingRef.current) {
      return;
    }
    isSavingRef.current = true;

    try {
      setLoading(true);
      resetSubmitProgress();

      // Validate expense data — progress starts AFTER synchronous validation passes
      const validatedExpense = expenseSchema.parse({
        ...expense,
        expense_date: expense.expense_date,
      });

      // Validate configurable base fields (org-level)
      const titleCfg = getBaseField("title");
      const destinationCfg = getBaseField("destination");
      const categoryCfg = getBaseField("category");
      const amountCfg = getBaseField("amount");
      const dateCfg = getBaseField("expense_date");

      if (titleCfg.is_visible && titleCfg.is_required && !String(validatedExpense.title || "").trim()) {
        throw new Error(`${titleCfg.label || "Title"} is required`);
      }
      if (destinationCfg.is_visible && destinationCfg.is_required && !String(validatedExpense.destination || "").trim()) {
        throw new Error(t("form.fieldRequired", { field: destinationCfg.label }));
      }
      if (!String(validatedExpense.category || "").trim()) {
        throw new Error(t("form.validation.categoryRequired"));
      }
      if (amountCfg.is_visible && amountCfg.is_required && !(Number(validatedExpense.amount) > 0)) {
        throw new Error(`${amountCfg.label || "Amount"} must be greater than 0`);
      }
      if (dateCfg.is_visible && dateCfg.is_required && !validatedExpense.expense_date) {
        throw new Error(t("form.fieldRequired", { field: dateCfg.label }));
      }

      // Validate form fields
      for (const field of categoryFormFields) {
        const template = field.template;
        const isRequired = field.required !== null ? field.required : template.required;
        const value = formFieldValues[template.id] || "";

        if (isRequired && !value.trim()) {
          throw new Error(`${template.name} is required`);
        }

        // Validate number fields
        if (template.field_type === 'number' && value) {
          const numValue = parseFloat(value);
          if (isNaN(numValue)) {
            throw new Error(`${template.name} must be a valid number`);
          }
          if (template.validation_rules?.min !== undefined && numValue < template.validation_rules.min) {
            throw new Error(`${template.name} must be at least ${template.validation_rules.min}`);
          }
          if (template.validation_rules?.max !== undefined && numValue > template.validation_rules.max) {
            throw new Error(`${template.name} must be at most ${template.validation_rules.max}`);
          }
        }
      }

      if (allowConditionalDropdown && optionBranches.length > 0) {
        const branchValidation = validateVisibleBranchFields(
          optionBranches,
          formFieldValues,
          branchValues,
          allowNestedConditional,
        );
        if (!branchValidation.valid) {
          throw new Error(
            `Please complete: ${branchValidation.missing.join(", ")}`,
          );
        }
      }

      // Check if bill photos are required based on amount.
      // attachmentRequiredAboveAmount is fetched on form init and kept in state — no
      // need for another DB round-trip here.
      const currentAttachmentLimit = attachmentRequiredAboveAmount;
      const expenseAmount = validatedExpense.amount;
      const requiresAttachment = expenseAmount > currentAttachmentLimit;

      if (requiresAttachment) {
        if (user?.id) {
          syncSessionTempFilenamesFromAttachments(
            user.id,
            attachments,
            sessionTempFilenamesRef.current,
          );
          for (const name of parseTempStorageNamesFromUrls(attachments, user.id)) {
            sessionTempFilenamesRef.current.add(name);
          }
        }

        if (!isEditing) {
          const hasAttachmentsInState = attachments && attachments.length > 0;
          const hasTempUploadsInSession = sessionTempFilenamesRef.current.size > 0;

          if (!hasAttachmentsInState && !hasTempUploadsInSession) {
            throw new Error(
              `Bill photos are required for expenses above ₹${currentAttachmentLimit}. Please upload at least one photo of your receipt or bill.`
            );
          }
        } else if (id) {
          const hasAttachmentsInState = attachments && attachments.length > 0;
          if (!hasAttachmentsInState) {
            // Cheap existence check: only current expense_id
            const { data: existingAttachments, error: existingAttachmentsError } = await supabase
              .from("attachments")
              .select("id")
              .eq("expense_id", id)
              .limit(1);

            if (existingAttachmentsError) {
              throw new Error("Failed to verify attachments. Please try again or contact support.");
            }

            const hasExistingAttachments = (existingAttachments && existingAttachments.length > 0) || false;
            if (!hasExistingAttachments) {
              throw new Error(
                `Bill photos are required for expenses above ₹${currentAttachmentLimit}. Please upload at least one photo of your receipt or bill.`
              );
            }
          }
        }
      }

      // Prepare data for ExpenseService
      // Use expense_date for both trip_start and trip_end since DB requires both.
      // Build YYYY-MM-DD from local date parts to avoid timezone shifting the day.
      const d = validatedExpense.expense_date;
      const expenseDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const expenseData: CreateExpenseData | UpdateExpenseData = {
        title: validatedExpense.title,
        destination: validatedExpense.destination,
        trip_start: expenseDateStr,
        trip_end: expenseDateStr,
        purpose: validatedExpense.purpose,
        amount: validatedExpense.amount,
        category: validatedExpense.category,
      };

      // Validation passed — now start showing progress
      startSubmitProgress(
        isEditing ? t("progress.saving") : t("progress.preparing"),
        { description: isEditing ? t("progress.savingHint") : t("progress.preparingHint"), currentStep: 1, totalSteps: isEditing ? 3 : 4 },
      );

      if (isEditing && id) {
        updateSubmitProgress(t("progress.saving"), { description: t("progress.savingHint"), currentStep: 1, totalSteps: 3 });
        await ExpenseService.updateExpense(id, user.id, expenseData);

        // Attachment processing (move → enforce) and custom field saving are independent
        // — run in parallel. enforceMaxAttachmentSize must still follow moveTempFilesToExpense.
        updateSubmitProgress(t("progress.savingReceipts"), { description: t("progress.savingReceiptsHint"), currentStep: 2, totalSteps: 3 });
        await Promise.all([
          (async () => {
            await moveTempFilesToExpense(id, {
              requireAtLeastOne: requiresAttachment,
              attachmentUrls: attachments,
            });
            await enforceMaxAttachmentSize(id);
          })(),
          saveFormFieldValues(id),
        ]);
        // Category-usage tracking is non-critical analytics — don't make the user wait on
        // it before the submit completes and we navigate. Runs in the background.
        void trackCategoryUsage(validatedExpense.category).catch(() => { });

        // Resubmit rejected/draft; keep submitted lines submitted (same as editing a regular expense).
        if (expenseStatus === "rejected" || expenseStatus === "draft") {
          updateSubmitProgress(t("progress.submitting"), { description: t("progress.submittingHint"), currentStep: 3, totalSteps: 3 });
          await ExpenseService.submitExpense(id, user.id);
        }

        persistSubmittedSafetyCopy(id, "submitted");
      } else {
        // Create new expense (starts as draft until submitExpense succeeds)
        updateSubmitProgress(t("progress.saving"), { description: t("progress.savingHint"), currentStep: 2, totalSteps: 4 });
        const newExpense = await ExpenseService.createExpense(user.id, expenseData as CreateExpenseData);

        // Custom field saving and attachment processing are independent — run in parallel.
        updateSubmitProgress(t("progress.savingReceipts"), { description: t("progress.savingReceiptsHint"), currentStep: 3, totalSteps: 4 });
        // enforceMaxAttachmentSize must still run after moveTempFilesToExpense (sequential
        // within the attachment track via the inner async IIFE).
        const [fieldsResult, attachmentResult] = await Promise.allSettled([
          saveFormFieldValues(newExpense.id),
          (async () => {
            await moveTempFilesToExpense(newExpense.id, {
              requireAtLeastOne: requiresAttachment,
              attachmentUrls: attachments,
            });
            await enforceMaxAttachmentSize(newExpense.id);
            if (requiresAttachment) {
              const hasPersisted = await expenseHasPersistedAttachments(
                newExpense.id,
                organizationId,
              );
              if (!hasPersisted) {
                throw new Error(
                  "Bill photos could not be saved to this expense. Please re-upload your receipts and try again.",
                );
              }
            }
          })(),
        ]);

        if (attachmentResult.status === "rejected") {
          const attachmentMessage =
            attachmentResult.reason instanceof Error
              ? attachmentResult.reason.message
              : "Failed to link bill photos to this expense.";

          if (fieldsResult.status === "rejected") {
            console.warn("Could not save form fields on draft expense:", fieldsResult.reason);
          }

          persistSubmittedSafetyCopy(newExpense.id, "draft");

          sessionTempFilenamesRef.current.clear();
          sessionTempUploadMetaRef.current.clear();
          tempStoragePathByUrlRef.current.clear();
          persistedAttachmentUrlsRef.current.clear();
          finalizationResultsRef.current = [];
          sessionBlobCacheRef.current = new Map();
          finalizeAfterSubmit();
          resetExpenseFormState();

          // Show warning state (not success — receipt fallback is a partial outcome)
          warnSubmitProgress(t("progress.draftWarning"), { description: t("progress.draftWarningHint") });

          toast({
            variant: "destructive",
            title: "Expense saved as draft",
            description: `${attachmentMessage} Open the expense to re-upload receipts and submit.`,
          });

          navigate(`/expenses/${newExpense.id}`, { state: { refreshExpenses: true } });
          return;
        }

        // Attachments succeeded. If field saving failed, surface the error so the
        // expense stays a draft and the user isn't told it was submitted.
        if (fieldsResult.status === "rejected") {
          throw fieldsResult.reason;
        }

        // Both tracks succeeded — submit.
        updateSubmitProgress(t("progress.submitting"), { description: t("progress.submittingHint"), currentStep: 4, totalSteps: 4 });
        await ExpenseService.submitExpense(newExpense.id, user.id);

        // Category-usage tracking is non-critical analytics — don't make the user wait on
        // it before the submit completes and we navigate. Runs in the background.
        void trackCategoryUsage(validatedExpense.category).catch(() => { });

        persistSubmittedSafetyCopy(newExpense.id, "submitted");
      }

      const isResubmission = expenseStatus === "rejected";
      completeSubmitProgress(isEditing ? t("progress.editComplete") : t("progress.complete"));
      sessionTempFilenamesRef.current.clear();
      sessionTempUploadMetaRef.current.clear();
      tempStoragePathByUrlRef.current.clear();
      persistedAttachmentUrlsRef.current.clear();
      finalizationResultsRef.current = [];
      sessionBlobCacheRef.current = new Map();
      finalizeAfterSubmit();
      if (!isEditing) {
        resetExpenseFormState();
      }
      toast({
        title: t("common:success"),
        description: isResubmission
          ? t("form.toast.submitted")
          : isEditing
            ? t("form.toast.saved")
            : t("toast.submitted"),
      });

      navigate(isEditing && id ? `/expenses/${id}` : "/expenses", {
        // After a successful submit, land on the all-expenses list — not the drafts tab.
        state: { refreshExpenses: true, expensesTab: "all" },
      });
    } catch (error: any) {
      failSubmitProgress(
        submitProgress.phase || t("form.toast.error"),
        error?.message || t("form.toast.error"),
      );
      console.error("Error saving expense:", error);
      console.error("Error details:", {
        message: error?.message,
        code: error?.code,
        details: error?.details,
        hint: error?.hint,
        stack: error?.stack
      });

      if (error instanceof z.ZodError) {
        toast({
          variant: "destructive",
          title: t("common:error"),
          description: error.errors[0].message,
        });
      } else {
        // Provide more detailed error information
        let errorMessage = t("toast.error");
        if (error?.message) {
          errorMessage = error.message;
        } else if (error?.code) {
          errorMessage = `Database error (${error.code}): ${error.message || 'Unknown error'}`;
        } else if (typeof error === 'object' && error !== null) {
          errorMessage = JSON.stringify(error, null, 2);
        }

        toast({
          variant: "destructive",
          title: t("common:error"),
          description: errorMessage,
        });
      }
    } finally {
      setLoading(false);
      isSavingRef.current = false;
    }
  };

  return (
    <MobileExpenseFormLayout active={isMobile}>
      <div className={cn("space-y-4 sm:space-y-6 lg:space-y-8 max-w-4xl mx-auto", isMobile && "pb-24 w-full min-w-0")}>
        {/* Center-aligned Header */}
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            {isEditing
              ? expenseStatus === "rejected"
                ? t("form.titleResubmit")
                : t("form.titleEdit")
              : t("form.titleNew")}
          </h1>
          <p className="text-sm sm:text-base text-muted-foreground mt-2">
            {isEditing
              ? expenseStatus === "rejected"
                ? t("form.descriptionResubmit")
                : t("form.descriptionEdit")
              : t("form.descriptionNew")}
          </p>
        </div>

        {isEditing && batchInfo && id && (
          <BatchExpenseContextCard
            batchInfo={batchInfo}
            siblings={batchSiblings}
            currentExpenseId={id}
            userId={user?.id}
            userRole={userRole}
            variant="edit"
          />
        )}

        <div className="flex justify-center">
          {/* Expense Details */}
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle className="text-center">{t("form.title")}</CardTitle>
              <CardDescription className="text-center">{t("form.cardDescription")}</CardDescription>
              <ExpenseFormDraftBanner notice={draftNotice} className="mt-3" />
            </CardHeader>
            <CardContent className="space-y-4">
              {!activeUserId ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm">{t("form.draft.loadingSession")}</p>
                </div>
              ) : !formReady ? (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  <p className="text-sm">
                    {isEditRoute ? t("form.draft.loadingExpense") : t("form.draft.loading")}
                  </p>
                </div>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleClearForm()}
                    disabled={loading}
                    className="w-full"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t("form.clearForm")}
                  </Button>
                  {!effectiveOrganizationId && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
                      <Loader2 className="inline h-4 w-4 animate-spin mr-2 align-[-2px]" />
                      {t("form.draft.loadingOrg")}
                    </div>
                  )}
                  <div className={cn("space-y-3", !getBaseField("category").is_visible && "hidden")}>
                    <Label htmlFor="category">{getBaseField("category").label}{getBaseField("category").is_required ? " *" : ""}</Label>

                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <BaseExpenseFieldInput
                          config={getBaseField("category")}
                          value={expense.category}
                          onChange={async (v) => {
                            setExpense((prev) => ({ ...prev, category: v }));
                            await fetchCategoryFormFields(v);
                          }}
                          featureEnabled={baseFieldCustomizationEnabled}
                          organizationId={effectiveOrganizationId}
                          userId={activeUserId}
                          id="category"
                          placeholder={t("form.selectCategory")}
                          defaultControl={
                            <Popover open={categoryPickerOpen} onOpenChange={setCategoryPickerOpen}>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  role="combobox"
                                  className="w-full justify-between"
                                  id="category"
                                >
                                  {expense.category || (loadingCategories ? t("form.loadingCategories") : t("form.selectCategory"))}
                                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                                <Command>
                                  <CommandInput placeholder={t("form.searchCategories")} />
                                  <CommandList>
                                    <CommandEmpty>{t("form.noCategories")}</CommandEmpty>
                                    <CommandGroup>
                                      {categories.map((c) => (
                                        <CommandItem
                                          key={c}
                                          value={c}
                                          onSelect={async () => {
                                            setExpense((prev) => ({ ...prev, category: c }));
                                            setCategoryPickerOpen(false);
                                            await fetchCategoryFormFields(c);
                                          }}
                                        >
                                          <Check
                                            className={cn(
                                              "mr-2 h-4 w-4",
                                              expense.category === c ? "opacity-100" : "opacity-0"
                                            )}
                                          />
                                          {c}
                                        </CommandItem>
                                      ))}
                                    </CommandGroup>
                                  </CommandList>
                                </Command>
                              </PopoverContent>
                            </Popover>
                          }
                        />
                      </div>
                      {isAdmin && (
                        <Button type="button" variant="outline" onClick={() => setAddCatOpen(true)}>{t("form.addCategory")}</Button>
                      )}
                    </div>

                    {/* Recommended Categories - Prominent below the dropdown */}
                    {recommendedCategories.length > 0 && (
                      <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-lg border-2 border-blue-200 dark:border-blue-800 shadow-sm">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <Label className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                              ⭐ {t("form.recommended.title")}
                            </Label>
                            <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
                              {t("form.recommended.subtitle")}
                            </p>
                          </div>
                          {showRecommended && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-2 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
                              onClick={() => setShowRecommended(false)}
                            >
                              {t("form.recommended.hide")}
                            </Button>
                          )}
                        </div>
                        {showRecommended ? (
                          <div className="flex flex-wrap gap-2">
                            {recommendedCategories.map((cat) => (
                              <Button
                                key={cat}
                                type="button"
                                variant={expense.category === cat ? "default" : "outline"}
                                size="sm"
                                className={cn(
                                  "h-9 text-sm font-medium transition-all",
                                  expense.category === cat
                                    ? "bg-blue-600 hover:bg-blue-700 text-white border-blue-600"
                                    : "bg-white dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-blue-300 dark:border-blue-700 text-blue-900 dark:text-blue-100"
                                )}
                                onClick={async () => {
                                  setExpense((prev) => ({ ...prev, category: cat }));
                                  await fetchCategoryFormFields(cat);
                                }}
                              >
                                {cat}
                              </Button>
                            ))}
                          </div>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900"
                            onClick={() => setShowRecommended(true)}
                          >
                            {t("form.recommended.show", { count: recommendedCategories.length })}
                          </Button>
                        )}
                      </div>
                    )}

                    {!categories.length && (
                      <p className="text-xs text-muted-foreground">
                        {isAdmin ? t("form.noCategoriesAdmin") : t("form.noCategoriesUser")}
                      </p>
                    )}
                  </div>

                  <CategoryFormFieldsSection
                    categoryFormFields={categoryFormFields}
                    formFieldValues={formFieldValues}
                    onFormFieldValuesChange={setFormFieldValues}
                    optionBranches={allowConditionalDropdown ? optionBranches : []}
                    branchValues={branchValues}
                    onBranchValuesChange={setBranchValues}
                    allowNested={allowNestedConditional}
                    organizationId={organizationId}
                    userId={user?.id}
                  />

                  <div className={cn("space-y-2", !getBaseField("title").is_visible && "hidden")}>
                    <Label htmlFor="title">{getBaseField("title").label}{getBaseField("title").is_required ? " *" : ""}</Label>
                    <BaseExpenseFieldInput
                      config={getBaseField("title")}
                      value={expense.title}
                      onChange={(v) => setExpense((prev) => ({ ...prev, title: v }))}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={effectiveOrganizationId}
                      userId={activeUserId}
                      id="title"
                      placeholder={t("form.placeholders.title")}
                      defaultControl={
                        <Input
                          id="title"
                          value={expense.title}
                          onChange={(e) => setExpense((prev) => ({ ...prev, title: e.target.value }))}
                          placeholder={t("form.placeholders.title")}
                        />
                      }
                    />
                  </div>

                  <div className={cn("space-y-2", !getBaseField("destination").is_visible && "hidden")}>
                    <Label htmlFor="destination">{getBaseField("destination").label}{getBaseField("destination").is_required ? " *" : ""}</Label>
                    <BaseExpenseFieldInput
                      config={getBaseField("destination")}
                      value={expense.destination}
                      onChange={(v) => setExpense((prev) => ({ ...prev, destination: v }))}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={effectiveOrganizationId}
                      userId={activeUserId}
                      id="destination"
                      placeholder={t("form.placeholders.destination")}
                      defaultControl={
                        <Input
                          id="destination"
                          value={expense.destination}
                          onChange={(e) => setExpense((prev) => ({ ...prev, destination: e.target.value }))}
                          placeholder={t("form.placeholders.destination")}
                        />
                      }
                    />
                  </div>

                  <div className={cn("space-y-2", !getBaseField("expense_date").is_visible && "hidden")}>
                    <Label>{getBaseField("expense_date").label}{getBaseField("expense_date").is_required ? " *" : ""}</Label>
                    <BaseExpenseFieldInput
                      config={getBaseField("expense_date")}
                      value={expense.expense_date ? format(expense.expense_date, "yyyy-MM-dd") : ""}
                      onChange={(v) => {
                        const parsed = parseLocalDate(v);
                        setExpense((prev) => ({ ...prev, expense_date: parsed ?? prev.expense_date }));
                      }}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={effectiveOrganizationId}
                      userId={activeUserId}
                      placeholder={t("form.placeholders.pickDate")}
                      defaultControl={
                        <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              className={cn(
                                "w-full justify-start text-left font-normal",
                                !expense.expense_date && "text-muted-foreground"
                              )}
                            >
                              <CalendarIcon className="mr-2 h-4 w-4" />
                              {expense.expense_date
                                ? format(expense.expense_date, "PPP", { locale: undefined })
                                : t("form.placeholders.pickDate")}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-auto p-0">
                            <Calendar
                              mode="single"
                              selected={expense.expense_date}
                              onSelect={(date) => {
                                if (!date) return;
                                // Use local date parts so the highlighted day matches the day the user clicked (no off-by-one)
                                const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
                                setExpense((prev) => ({ ...prev, expense_date: localMidnight }));
                                setDatePickerOpen(false);
                              }}
                              initialFocus
                              disabled={(date) => {
                                // Disable all future dates (dates after today)
                                const today = new Date();
                                today.setHours(23, 59, 59, 999); // End of today
                                return date > today;
                              }}
                            />
                          </PopoverContent>
                        </Popover>
                      }
                    />
                  </div>

                  <div className={cn("space-y-2", !getBaseField("purpose").is_visible && "hidden")}>
                    <Label htmlFor="purpose">{getBaseField("purpose").label}{getBaseField("purpose").is_required ? " *" : ""}</Label>
                    <BaseExpenseFieldInput
                      config={getBaseField("purpose")}
                      value={expense.purpose}
                      onChange={(v) => setExpense((prev) => ({ ...prev, purpose: v }))}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={effectiveOrganizationId}
                      userId={activeUserId}
                      id="purpose"
                      placeholder={t("form.placeholders.purpose")}
                      defaultControl={
                        <Textarea
                          id="purpose"
                          value={expense.purpose}
                          onChange={(e) => setExpense((prev) => ({ ...prev, purpose: e.target.value }))}
                          placeholder={t("form.placeholders.purpose")}
                          rows={3}
                        />
                      }
                    />
                  </div>

                  <div className={cn("space-y-2", !getBaseField("amount").is_visible && "hidden")}>
                    <Label htmlFor="amount">{getBaseField("amount").label}{getBaseField("amount").is_required ? " *" : ""}</Label>
                    <BaseExpenseFieldInput
                      config={getBaseField("amount")}
                      value={expense.amount === 0 ? "" : String(expense.amount)}
                      onChange={(v) => {
                        const numValue = parseFloat(v);
                        setExpense((prev) => ({
                          ...prev,
                          amount: !isNaN(numValue) && numValue >= 0 ? numValue : 0,
                        }));
                      }}
                      featureEnabled={baseFieldCustomizationEnabled}
                      organizationId={effectiveOrganizationId}
                      userId={activeUserId}
                      id="amount"
                      placeholder={t("form.placeholders.amount")}
                      defaultControl={
                        <Input
                          id="amount"
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          onWheelCapture={blurFocusedNumberInputOnWheel}
                          value={expense.amount === 0 ? "" : expense.amount}
                          onChange={(e) => {
                            const value = e.target.value;
                            // Only update if value is valid number or empty
                            if (value === "" || value === ".") {
                              setExpense((prev) => ({ ...prev, amount: 0 }));
                            } else {
                              const numValue = parseFloat(value);
                              if (!isNaN(numValue) && numValue >= 0) {
                                setExpense((prev) => ({ ...prev, amount: numValue }));
                              }
                            }
                          }}
                          onBlur={(e) => {
                            // Ensure value is properly formatted on blur
                            const value = e.target.value;
                            if (value === "" || value === ".") {
                              setExpense((prev) => ({ ...prev, amount: 0 }));
                            } else {
                              const numValue = parseFloat(value);
                              if (!isNaN(numValue) && numValue >= 0) {
                                setExpense((prev) => ({ ...prev, amount: numValue }));
                              }
                            }
                          }}
                          placeholder={t("form.placeholders.amount")}
                        />
                      }
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Line Items removed from the creation form */}
        </div>

        {formReady && activeUserId && (
          <>
            {/* File Upload Section - Conditionally Required */}
            <div className="mt-8 flex justify-center">
              <Card className={`w-full max-w-2xl ${!isAttachmentRequired ? 'opacity-75' : ''}`}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {t("form.bills.title")}
                    {isAttachmentRequired && (
                      <span className="text-red-500 text-sm font-normal">* {t("form.bills.requiredTag")}</span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {isAttachmentRequired
                      ? t("form.bills.descriptionRequired", {
                        amount: formatINR(attachmentRequiredAboveAmount, getDateLocale(i18n.language)),
                      })
                      : t("form.bills.descriptionOptional", {
                        amount: formatINR(attachmentRequiredAboveAmount, getDateLocale(i18n.language)),
                      })}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ErrorBoundary>
                    <FileUpload
                      key={`${isEditing && id ? id : "new"}-${fileUploadResetKey}`}
                      expenseId={isEditing && id ? id : "new"}
                      onBeforePickerOpen={flushExpenseDraftNow}
                      onUploadComplete={(attachment, blob) => {
                        if (attachment && attachment.file_url) {
                          const isTempUpload =
                            typeof attachment.id === "string" && attachment.id.startsWith("temp-");
                          if (user?.id) {
                            syncSessionTempFilenamesFromAttachments(
                              user.id,
                              [attachment.file_url],
                              sessionTempFilenamesRef.current,
                            );
                            for (const name of parseTempStorageNamesFromUrls(
                              [attachment.file_url],
                              user.id,
                            )) {
                              sessionTempFilenamesRef.current.add(name);
                            }
                          }
                          if (attachment.storage_path) {
                            sessionTempFilenamesRef.current.add(attachment.storage_path);
                            tempStoragePathByUrlRef.current.set(
                              attachment.file_url,
                              attachment.storage_path,
                            );
                            sessionTempUploadMetaRef.current.set(attachment.storage_path, {
                              filename: attachment.filename,
                              file_size: attachment.file_size ?? 0,
                              content_type: attachment.content_type || "image/jpeg",
                            });
                            if (blob) {
                              sessionBlobCacheRef.current.set(attachment.storage_path, blob);
                            }
                          } else if (isTempUpload && user?.id) {
                            console.warn("Temp upload missing storage_path; recovered from URL where possible.");
                          }
                          setAttachments((prev) => {
                            const next = [...prev, attachment.file_url];
                            formStateRef.current = {
                              ...formStateRef.current,
                              attachments: next,
                            };
                            return next;
                          });
                          flushExpenseDraftNow();
                        }
                      }}
                      required={isAttachmentRequired}
                      variant={isMobile ? "mobile" : undefined}
                    />
                  </ErrorBoundary>
                  {!isAttachmentRequired && (
                    <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                      <p className="text-sm text-blue-800">
                        ℹ️{" "}
                        {t("form.bills.infoUnderThreshold", {
                          threshold: formatINR(attachmentRequiredAboveAmount, getDateLocale(i18n.language)),
                          current: formatINR(expense.amount || 0, getDateLocale(i18n.language)),
                        })}
                      </p>
                    </div>
                  )}
                  {isAttachmentRequired && attachments.length > 0 && (
                    <div className="mt-4">
                      <p className="text-sm text-green-600 font-medium">
                        ✓{" "}
                        {t("form.bills.countUploaded", {
                          count: attachments.length,
                          defaultValue:
                            attachments.length === 1
                              ? "1 bill photo uploaded"
                              : `${attachments.length} bill photos uploaded`,
                        })}
                      </p>
                    </div>
                  )}
                  {isAttachmentRequired && attachments.length === 0 && (
                    <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-md">
                      <p className="text-sm text-yellow-800">
                        ⚠️{" "}
                        {t("form.bills.mustUpload", {
                          amount: formatINR(attachmentRequiredAboveAmount, getDateLocale(i18n.language)),
                        })}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Submit and Cancel Buttons — desktop only; mobile uses MobileStickyActionBar */}
            {!isMobile && (
              <div className="flex flex-col gap-2 w-full max-w-2xl mx-auto">
                {submitProgress.status !== "idle" && (
                  <AsyncOperationProgress
                    status={submitProgress.status}
                    title={submitProgress.phase}
                    description={submitProgress.description}
                    showSuccess={submitProgress.status === "success"}
                    onRetry={submitProgress.status === "error" ? () => void saveExpense() : undefined}
                    retryLabel={t("progress.retry")}
                  />
                )}
                <Button
                  onClick={() => saveExpense()}
                  disabled={loading || !formReady || !effectiveOrganizationId}
                  className="w-full"
                >
                  {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  {loading && submitProgress.phase ? submitProgress.phase : (isEditing && expenseStatus === "rejected" ? t("form.resubmit") : t("form.submit"))}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleCancelForm}
                  disabled={loading}
                  className="w-full"
                >
                  {t("common:cancel")}
                </Button>
              </div>
            )}
          </>
        )}

        {AddCategoryDialog}
      </div>
      {isMobile && (
        <MobileStickyActionBar
          onSubmit={saveExpense}
          onCancel={handleCancelForm}
          submitLabel={isEditing && expenseStatus === "rejected" ? t("form.resubmit") : t("form.submit")}
          disabled={loading || !formReady || !effectiveOrganizationId}
          loading={loading}
          progressTitle={submitProgress.phase || undefined}
          progressDescription={submitProgress.description}
          progressStatus={submitProgress.status}
        />
      )}
    </MobileExpenseFormLayout>
  );
}
