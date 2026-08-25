/**
 * DOC-107 — admin submits an expense on behalf of an employee.
 *
 * Admin picks an employee (search by name / email / employee ID), fills the
 * same core fields the employee's own form collects, and submits. No
 * attachment step exists here by design: only an admin can reach this page,
 * so the bill-photo-above-amount rule (enforced for self-submission in
 * ExpenseForm.tsx / ExpenseService.submitExpense) never applies to this path
 * — admin_submit_expense_for_employee_v1 does not check for one.
 *
 * The expense lands as status "submitted", owned by the employee (user_id),
 * with created_by_admin_id recording who created it. It enters the same
 * review pipeline as a self-submitted expense — the RPC ports the same
 * hierarchy-routing logic ExpenseService.submitExpense uses, so reviewers see
 * it exactly where they would see any other submission. The employee's
 * dashboard updates live because the RPC also writes them a notification
 * (Dashboard.tsx's realtime subscription listens for that).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Check, ChevronsUpDown, CalendarIcon, Loader2, Send, UserRoundSearch, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { fetchOrganizationUsers, type OrganizationUserRow } from "@/lib/orgUsers";
import { userMatchesManagementSearch } from "@/lib/approvalHierarchy";
import {
  submitExpenseForEmployee, saveExpenseCustomFields, applyAdminSubmitStatusChoice,
  type AdminSubmitStatusChoice,
} from "@/lib/adminSubmitExpense";
import { SubmitStatusChoiceDialog } from "@/components/SubmitStatusChoiceDialog";
import { FileUpload } from "@/components/FileUpload";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { BulkExpenseImportPanel } from "@/components/BulkExpenseImportPanel";
import { AdminExpenseHistoryTab } from "@/components/AdminExpenseHistoryTab";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import {
  DEFAULT_BASE_FIELD_CONFIG, resolveBaseFieldConfig, type BaseExpenseFieldKey, type BaseFieldConfig,
} from "@/lib/expenseFormConfig";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";
import { useOnDemandOptionBranches } from "@/hooks/useOnDemandOptionBranches";
import { validateVisibleBranchFields } from "@/lib/conditionalFormFields";
import { buildExpenseCustomFieldPayload, type ExpenseCustomFieldValuePayload } from "@/lib/expenseFormFieldPayload";

const emptyForm = {
  title: "",
  destination: "",
  purpose: "",
  category: "",
  amount: "",
};

export default function AdminSubmitExpense() {
  const { t } = useTranslation(["admin", "expenses", "common"]);
  // translateBaseFieldConfig calls t(key) with no explicit namespace and
  // expects "expenses" to be the DEFAULT namespace (that's how ExpenseForm.tsx
  // itself calls it — useTranslation(["expenses", ...])) — this page's `t`
  // defaults to "admin" instead, so a namespace-scoped t is needed just for
  // that call, or every base-field label renders as a raw "form.fields.x" key.
  const { t: tExpenses } = useTranslation("expenses");
  const { organizationId, organizationFeatureFlags, user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [employees, setEmployees] = useState<OrganizationUserRow[]>([]);
  const [loadingEmployees, setLoadingEmployees] = useState(true);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState<OrganizationUserRow | null>(null);

  const [categories, setCategories] = useState<string[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);

  const [form, setForm] = useState(emptyForm);
  const [date, setDate] = useState<Date>(new Date());
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // ── Org-accurate custom fields (mirrors ExpenseForm.tsx's own fetch/render/validate) ──
  const [baseFieldConfig, setBaseFieldConfig] = useState<Record<BaseExpenseFieldKey, BaseFieldConfig>>(
    DEFAULT_BASE_FIELD_CONFIG,
  );
  const [categoryFormFields, setCategoryFormFields] = useState<any[]>([]);
  const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({});
  const [branchValues, setBranchValues] = useState<Record<string, string>>({});
  /** Set only when an expense was created but its custom-field save failed —
   *  retry must re-run ONLY the custom-field save, never re-submit the base
   *  expense (that would create a duplicate). desiredStatus/statusComment are
   *  remembered here so a successful retry can THEN apply the originally
   *  chosen status transition — verify/approve must never run ahead of a
   *  successful custom-field save (see applyAdminSubmitStatusChoice's doc
   *  comment: approving incomplete data would still trigger the atomic
   *  balance deduction). */
  const [pendingCustomFieldRetry, setPendingCustomFieldRetry] = useState<{
    expenseId: string;
    values: ExpenseCustomFieldValuePayload[];
    employeeName: string;
    desiredStatus: AdminSubmitStatusChoice;
    statusComment: string;
  } | null>(null);
  const [retryingCustomFields, setRetryingCustomFields] = useState(false);

  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [confirmingStatusChoice, setConfirmingStatusChoice] = useState(false);
  /** Set only when the expense (and its custom fields, if any) were saved
   *  fine, but the chosen verify/approve transition itself failed —
   *  distinct from pendingCustomFieldRetry since the expense is otherwise
   *  complete here; retry re-runs only the status transition. */
  const [lastStatusTransitionFailure, setLastStatusTransitionFailure] = useState<{
    expenseId: string;
    employeeName: string;
    desiredStatus: AdminSubmitStatusChoice;
    statusComment: string;
  } | null>(null);
  const [retryingStatusTransition, setRetryingStatusTransition] = useState(false);
  /** Set after a fully successful submit — drives the optional, skippable
   *  "attach a receipt" panel. Cleared on the next submit or dismiss. */
  const [lastCreatedExpense, setLastCreatedExpense] = useState<{ expenseId: string; employeeName: string } | null>(null);

  const baseFieldCustomizationEnabled =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_base_field_input_customization] === true;
  const allowConditionalDropdown =
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_conditional_dropdown_fields] === true;
  const allowNestedConditional =
    allowConditionalDropdown &&
    organizationFeatureFlags[ORGANIZATION_FEATURE_KEYS.allow_nested_conditional_dropdown_fields] === true;

  const translatedBaseFields = useMemo(
    () => translateBaseFieldConfig(baseFieldConfig, tExpenses),
    [baseFieldConfig, tExpenses],
  );
  const getBaseField = (key: BaseExpenseFieldKey): BaseFieldConfig =>
    translatedBaseFields[key] || translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, tExpenses)[key];

  const {
    optionBranches,
    selectOptionValue: selectOptionBranches,
    reset: resetOptionBranches,
    hasError: optionBranchLoadError,
  } = useOnDemandOptionBranches(organizationId);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setLoadingEmployees(true);
    fetchOrganizationUsers(organizationId)
      .then((rows) => { if (!cancelled) setEmployees(rows); })
      .catch(() => { if (!cancelled) setEmployees([]); })
      .finally(() => { if (!cancelled) setLoadingEmployees(false); });
    return () => { cancelled = true; };
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setLoadingCategories(true);
    void (async () => {
      // expense_categories predates the generated types.ts (same root cause
      // documented in src/lib/adminSubmitExpense.ts) — narrow cast, not a new pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      let { data, error } = await db
        .from("expense_categories")
        .select("name, active")
        .eq("organization_id", organizationId)
        .eq("active", true)
        .order("name");
      if (error && (error as { code?: string }).code === "42703") {
        const retry = await db
          .from("expense_categories")
          .select("name, is_active")
          .eq("organization_id", organizationId)
          .eq("is_active", true)
          .order("name");
        data = retry.data;
      }
      if (!cancelled) {
        setCategories((data ?? []).map((c) => String((c as { name?: unknown }).name ?? "")).filter(Boolean));
        setLoadingCategories(false);
      }
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  // Mirrors ExpenseForm.tsx's fetchBaseFieldConfig (organization_expense_form_fields).
  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await (supabase as any)
          .from("organization_expense_form_fields")
          .select("*")
          .eq("organization_id", organizationId);
        if (!cancelled && !error && data) {
          setBaseFieldConfig(resolveBaseFieldConfig(data as Partial<BaseFieldConfig>[]));
        }
      } catch {
        // defaults already set — same fallback behavior as ExpenseForm.tsx
      }
    })();
    return () => { cancelled = true; };
  }, [organizationId]);

  // Mirrors ExpenseForm.tsx's fetchCategoryFormFields (expense_category_form_fields
  // + expense_form_field_templates). Wrapped in a ref for the same reason
  // ExpenseForm.tsx:509-514 documents: without it, a category-change callback
  // registered before organizationId loads would close over a stale (null) value.
  const fetchCategoryFormFields = async (categoryName: string) => {
    if (!organizationId || !categoryName) {
      setCategoryFormFields([]);
      setFormFieldValues({});
      resetOptionBranches();
      setBranchValues({});
      return;
    }
    try {
      // expense_categories / expense_category_form_fields predate the generated
      // types.ts (same root cause documented in src/lib/adminSubmitExpense.ts) —
      // narrow cast, not a new pattern.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;
      const { data: categoryData } = await db
        .from("expense_categories")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("name", categoryName)
        .maybeSingle();

      if (!categoryData) {
        setCategoryFormFields([]);
        setFormFieldValues({});
        resetOptionBranches();
        setBranchValues({});
        return;
      }

      const { data: assignments, error } = await db
        .from("expense_category_form_fields")
        .select(`*, expense_form_field_templates(*)`)
        .eq("organization_id", organizationId)
        .eq("category_id", categoryData.id)
        .order("display_order", { ascending: true });
      if (error) throw error;

      const fields = (assignments || [])
        .map((assignment: any) => ({ ...assignment, template: assignment.expense_form_field_templates }))
        .filter((assignment: any) => {
          const submitFlag = assignment.show_on_submit;
          const templateSubmitFlag = assignment.template?.show_on_submit;
          return (submitFlag ?? templateSubmitFlag ?? true) === true;
        });

      setCategoryFormFields(fields);
      resetOptionBranches();
      setBranchValues({});

      const initialValues: Record<string, string> = {};
      fields.forEach((field: any) => {
        if (field.template?.default_value) {
          initialValues[field.template.id] = field.template.default_value;
        } else if (field.template?.field_type === "checkbox") {
          initialValues[field.template.id] = "false";
        }
      });
      setFormFieldValues(initialValues);
    } catch (e) {
      console.error("Failed to fetch category form fields:", e);
      setCategoryFormFields([]);
    }
  };
  const fetchCategoryFormFieldsRef = useRef(fetchCategoryFormFields);
  fetchCategoryFormFieldsRef.current = fetchCategoryFormFields;

  const filteredEmployees = useMemo(() => {
    if (!employeeSearch.trim()) return employees;
    return employees.filter((e) =>
      userMatchesManagementSearch(
        { name: e.name, email: e.email, role: e.role, employee_id: e.employee_id },
        employeeSearch,
      ),
    );
  }, [employees, employeeSearch]);

  const resetForm = () => {
    setForm(emptyForm);
    setDate(new Date());
    setSelectedEmployee(null);
    setCategoryFormFields([]);
    setFormFieldValues({});
    setBranchValues({});
    resetOptionBranches();
  };

  const catField = getBaseField("category");
  const titleField = getBaseField("title");
  const destinationField = getBaseField("destination");
  const dateField = getBaseField("expense_date");
  const purposeField = getBaseField("purpose");
  const amountField = getBaseField("amount");

  const canSubmit =
    Boolean(organizationId) &&
    Boolean(selectedEmployee) &&
    !pendingCustomFieldRetry &&
    !lastStatusTransitionFailure &&
    (!titleField.is_visible || !titleField.is_required || form.title.trim() !== "") &&
    (!destinationField.is_visible || !destinationField.is_required || form.destination.trim() !== "") &&
    (!catField.is_visible || !catField.is_required || form.category.trim() !== "") &&
    (!amountField.is_visible || !amountField.is_required || Number(form.amount) > 0) &&
    !submitting;

  /**
   * Validates the form, and if valid, opens the status-choice popup instead
   * of submitting directly — the admin picks Submitted/Verified/Approved
   * there, and performSubmit() runs only after that confirmation.
   */
  const handleSubmitClick = () => {
    if (!organizationId || !selectedEmployee) return;
    const amount = Number(form.amount) || 0;
    if (amountField.is_visible && amountField.is_required && !(amount > 0)) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: `${amountField.label} must be greater than 0`,
        variant: "destructive",
      });
      return;
    }
    if (date > new Date()) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: t("submitForEmployee.errors.futureDate", { ns: "admin" }),
        variant: "destructive",
      });
      return;
    }

    // Category-assigned custom fields: required-ness + number range, exactly
    // mirroring ExpenseForm.tsx's own pre-submit validation.
    for (const field of categoryFormFields as any[]) {
      const template = field.template;
      const isRequired = field.required !== null ? field.required : template.required;
      const value = formFieldValues[template.id] || "";
      if (isRequired && !value.trim()) {
        toast({ title: t("submitForEmployee.errors.title", { ns: "admin" }), description: `${template.name} is required`, variant: "destructive" });
        return;
      }
      if (template.field_type === "number" && value) {
        const numValue = parseFloat(value);
        if (isNaN(numValue)) {
          toast({ title: t("submitForEmployee.errors.title", { ns: "admin" }), description: `${template.name} must be a valid number`, variant: "destructive" });
          return;
        }
        if (template.validation_rules?.min !== undefined && numValue < template.validation_rules.min) {
          toast({ title: t("submitForEmployee.errors.title", { ns: "admin" }), description: `${template.name} must be at least ${template.validation_rules.min}`, variant: "destructive" });
          return;
        }
        if (template.validation_rules?.max !== undefined && numValue > template.validation_rules.max) {
          toast({ title: t("submitForEmployee.errors.title", { ns: "admin" }), description: `${template.name} must be at most ${template.validation_rules.max}`, variant: "destructive" });
          return;
        }
      }
    }

    if (allowConditionalDropdown) {
      // A failed on-demand branch fetch must never let a required conditional
      // field silently vanish — block submission, same as ExpenseForm.tsx.
      if (optionBranchLoadError) {
        toast({
          title: t("submitForEmployee.errors.title", { ns: "admin" }),
          description: "Could not load additional field configuration for the selected option. Please retry before submitting.",
          variant: "destructive",
        });
        return;
      }
      if (optionBranches.length > 0) {
        const branchValidation = validateVisibleBranchFields(optionBranches, formFieldValues, branchValues, allowNestedConditional);
        if (!branchValidation.valid) {
          toast({
            title: t("submitForEmployee.errors.title", { ns: "admin" }),
            description: `Please complete: ${branchValidation.missing.join(", ")}`,
            variant: "destructive",
          });
          return;
        }
      }
    }

    setStatusDialogOpen(true);
  };

  /**
   * Runs only after the status-choice popup is confirmed. Sequencing is the
   * critical part: create -> save custom fields -> ONLY IF that step
   * succeeded (or had nothing to save) -> apply the chosen status
   * transition. A row whose custom-field save fails must never be
   * verified/approved — see applyAdminSubmitStatusChoice's doc comment.
   */
  const performSubmit = async (status: AdminSubmitStatusChoice, comment: string) => {
    if (!organizationId || !selectedEmployee || !user?.id) return;
    const amount = Number(form.amount) || 0;
    setConfirmingStatusChoice(true);
    setSubmitting(true);
    try {
      const dateStr = format(date, "yyyy-MM-dd");
      const result = await submitExpenseForEmployee({
        organizationId,
        employeeId: selectedEmployee.user_id,
        title: form.title.trim(),
        destination: form.destination.trim(),
        tripStart: dateStr,
        tripEnd: dateStr,
        category: form.category,
        amount,
        purpose: form.purpose.trim() || null,
      });

      const visibleBranchIds = allowConditionalDropdown
        ? new Set(optionBranches.filter((b) => formFieldValues[b.parent_template_id] === b.parent_option_value).map((b) => b.id))
        : new Set<string>();
      const customFieldValues = buildExpenseCustomFieldPayload({
        templateValues: formFieldValues,
        branchValues,
        visibleBranchIds,
      });

      const employeeName = selectedEmployee.name || selectedEmployee.email;
      if (customFieldValues.length > 0) {
        try {
          await saveExpenseCustomFields(organizationId, result.expense_id, customFieldValues);
        } catch (fieldErr) {
          // Expense already exists (submitted, reviewer notified) — do NOT
          // resubmit on retry, only re-run the custom-field save. The status
          // choice is remembered and applied ONLY after a successful retry.
          setPendingCustomFieldRetry({
            expenseId: result.expense_id, values: customFieldValues, employeeName,
            desiredStatus: status, statusComment: comment,
          });
          toast({
            title: t("submitForEmployee.errors.title", { ns: "admin" }),
            description: `Expense created for ${employeeName}, but its extra fields failed to save: ${fieldErr instanceof Error ? fieldErr.message : "unknown error"}. Use Retry below before submitting another.`,
            variant: "destructive",
          });
          resetForm();
          setStatusDialogOpen(false);
          return;
        }
      }

      if (status !== "submitted") {
        try {
          await applyAdminSubmitStatusChoice(status, result.expense_id, user.id, organizationId, comment);
        } catch (statusErr) {
          setLastStatusTransitionFailure({
            expenseId: result.expense_id, employeeName, desiredStatus: status, statusComment: comment,
          });
          toast({
            title: t("submitForEmployee.errors.title", { ns: "admin" }),
            description: `Expense created for ${employeeName}, but could not be set to ${status}: ${statusErr instanceof Error ? statusErr.message : "unknown error"}. Use Retry below before submitting another.`,
            variant: "destructive",
          });
          resetForm();
          setStatusDialogOpen(false);
          return;
        }
      }

      setLastCreatedExpense({ expenseId: result.expense_id, employeeName });
      toast({
        title: t("submitForEmployee.success.title", { ns: "admin" }),
        description: t("submitForEmployee.success.description", {
          ns: "admin",
          name: employeeName,
        }),
      });

      resetForm();
      setStatusDialogOpen(false);
    } catch (err) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: err instanceof Error ? err.message : t("submitForEmployee.errors.generic", { ns: "admin" }),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
      setConfirmingStatusChoice(false);
    }
  };

  const handleRetryCustomFields = async () => {
    if (!organizationId || !pendingCustomFieldRetry || !user?.id) return;
    setRetryingCustomFields(true);
    try {
      await saveExpenseCustomFields(organizationId, pendingCustomFieldRetry.expenseId, pendingCustomFieldRetry.values);
      if (pendingCustomFieldRetry.desiredStatus !== "submitted") {
        try {
          await applyAdminSubmitStatusChoice(
            pendingCustomFieldRetry.desiredStatus, pendingCustomFieldRetry.expenseId, user.id,
            organizationId, pendingCustomFieldRetry.statusComment,
          );
        } catch (statusErr) {
          setLastStatusTransitionFailure({
            expenseId: pendingCustomFieldRetry.expenseId,
            employeeName: pendingCustomFieldRetry.employeeName,
            desiredStatus: pendingCustomFieldRetry.desiredStatus,
            statusComment: pendingCustomFieldRetry.statusComment,
          });
          toast({
            title: t("submitForEmployee.errors.title", { ns: "admin" }),
            description: `Extra fields saved, but could not be set to ${pendingCustomFieldRetry.desiredStatus}: ${statusErr instanceof Error ? statusErr.message : "unknown error"}. Use Retry below.`,
            variant: "destructive",
          });
          setPendingCustomFieldRetry(null);
          return;
        }
      }
      toast({
        title: t("submitForEmployee.success.title", { ns: "admin" }),
        description: `Extra fields saved for ${pendingCustomFieldRetry.employeeName}'s expense.`,
      });
      setPendingCustomFieldRetry(null);
    } catch (err) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: err instanceof Error ? err.message : "Retry failed — the expense still has incomplete extra fields.",
        variant: "destructive",
      });
    } finally {
      setRetryingCustomFields(false);
    }
  };

  const handleRetryStatusTransition = async () => {
    if (!organizationId || !lastStatusTransitionFailure || !user?.id) return;
    setRetryingStatusTransition(true);
    try {
      await applyAdminSubmitStatusChoice(
        lastStatusTransitionFailure.desiredStatus, lastStatusTransitionFailure.expenseId, user.id,
        organizationId, lastStatusTransitionFailure.statusComment,
      );
      toast({
        title: t("submitForEmployee.success.title", { ns: "admin" }),
        description: `${lastStatusTransitionFailure.employeeName}'s expense is now ${lastStatusTransitionFailure.desiredStatus}.`,
      });
      setLastStatusTransitionFailure(null);
    } catch (err) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: err instanceof Error ? err.message : "Retry failed — the status change still has not been applied.",
        variant: "destructive",
      });
    } finally {
      setRetryingStatusTransition(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("submitForEmployee.heading", { ns: "admin" })}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t("submitForEmployee.subheading", { ns: "admin" })}
        </p>
      </div>

      {/* DOC-108 — bulk CSV/Excel import lives in its own tab and its own
          component (BulkExpenseImportPanel) so it cannot affect the single-
          employee form's state or JSX below, which is unchanged. */}
      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">
            {t("submitForEmployee.tabs.single", { ns: "admin" })}
          </TabsTrigger>
          <TabsTrigger value="bulk">
            {t("submitForEmployee.tabs.bulk", { ns: "admin" })}
          </TabsTrigger>
          <TabsTrigger value="history">
            History
          </TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="mt-4">
    <div className="max-w-2xl space-y-6">
      {pendingCustomFieldRetry && (
        <Card className="border-destructive">
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm text-destructive">
              Expense created for <strong>{pendingCustomFieldRetry.employeeName}</strong>, but its
              extra fields failed to save. Retry before submitting another expense.
            </p>
            <Button variant="outline" onClick={() => void handleRetryCustomFields()} disabled={retryingCustomFields}>
              {retryingCustomFields ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Retry saving extra fields
            </Button>
          </CardContent>
        </Card>
      )}
      {lastStatusTransitionFailure && (
        <Card className="border-destructive">
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm text-destructive">
              Expense created for <strong>{lastStatusTransitionFailure.employeeName}</strong>, but could not
              be set to <strong>{lastStatusTransitionFailure.desiredStatus}</strong>. It's still saved as
              submitted. Retry before submitting another expense.
            </p>
            <Button variant="outline" onClick={() => void handleRetryStatusTransition()} disabled={retryingStatusTransition}>
              {retryingStatusTransition ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RotateCcw className="mr-2 h-4 w-4" />}
              Retry setting to {lastStatusTransitionFailure.desiredStatus}
            </Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("submitForEmployee.employeeSectionTitle", { ns: "admin" })}
          </CardTitle>
          <CardDescription>
            {t("submitForEmployee.employeeSectionHint", { ns: "admin" })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Popover open={employeePickerOpen} onOpenChange={setEmployeePickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" className="w-full justify-between">
                <span className="flex items-center gap-2 truncate">
                  <UserRoundSearch className="h-4 w-4 shrink-0 opacity-60" />
                  {selectedEmployee
                    ? `${selectedEmployee.name || selectedEmployee.email}${selectedEmployee.employee_id ? ` (${selectedEmployee.employee_id})` : ""}`
                    : loadingEmployees
                      ? t("submitForEmployee.loadingEmployees", { ns: "admin" })
                      : t("submitForEmployee.selectEmployee", { ns: "admin" })}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder={t("submitForEmployee.searchPlaceholder", { ns: "admin" })}
                  value={employeeSearch}
                  onValueChange={setEmployeeSearch}
                />
                <CommandList>
                  <CommandEmpty>{t("submitForEmployee.noEmployees", { ns: "admin" })}</CommandEmpty>
                  <CommandGroup>
                    {filteredEmployees.map((e) => (
                      <CommandItem
                        key={e.user_id}
                        value={e.user_id}
                        onSelect={() => {
                          setSelectedEmployee(e);
                          setEmployeePickerOpen(false);
                          setEmployeeSearch("");
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedEmployee?.user_id === e.user_id ? "opacity-100" : "opacity-0",
                          )}
                        />
                        <div className="flex flex-col min-w-0">
                          <span className="truncate">{e.name || e.email}</span>
                          <span className="text-xs text-muted-foreground truncate">
                            {e.email}{e.employee_id ? ` · ${e.employee_id}` : ""}
                          </span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("form.title", { ns: "expenses" })}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Field order/visibility/labels/required-ness/dropdown-override below
              mirror ExpenseForm.tsx's own field-by-field rendering exactly (same
              fixed sequence: category, title, destination, date, purpose, amount)
              so an admin sees identically what the employee's own form would show. */}
          <div className={cn("space-y-2", !catField.is_visible && "hidden")}>
            <Label>{catField.label}{catField.is_required ? " *" : ""}</Label>
            <BaseExpenseFieldInput
              config={catField}
              value={form.category}
              onChange={(v) => { setForm((p) => ({ ...p, category: v })); void fetchCategoryFormFieldsRef.current(v); }}
              featureEnabled={baseFieldCustomizationEnabled}
              organizationId={organizationId}
              userId={user?.id}
              placeholder={t("form.selectCategory", { ns: "expenses" })}
              defaultControl={
                <Popover open={categoryPickerOpen} onOpenChange={setCategoryPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" className="w-full justify-between">
                      {form.category || (loadingCategories ? t("form.loadingCategories", { ns: "expenses" }) : t("form.selectCategory", { ns: "expenses" }))}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t("form.searchCategories", { ns: "expenses" })} />
                      <CommandList>
                        <CommandEmpty>{t("form.noCategories", { ns: "expenses" })}</CommandEmpty>
                        <CommandGroup>
                          {categories.map((c) => (
                            <CommandItem
                              key={c}
                              value={c}
                              onSelect={() => { setForm((p) => ({ ...p, category: c })); setCategoryPickerOpen(false); void fetchCategoryFormFieldsRef.current(c); }}
                            >
                              <Check className={cn("mr-2 h-4 w-4", form.category === c ? "opacity-100" : "opacity-0")} />
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
            onSelectOptionValue={allowConditionalDropdown ? selectOptionBranches : undefined}
            instanceId="admin-submit"
          />

          <div className={cn("space-y-2", !titleField.is_visible && "hidden")}>
            <Label htmlFor="admin-exp-title">{titleField.label}{titleField.is_required ? " *" : ""}</Label>
            <BaseExpenseFieldInput
              config={titleField}
              value={form.title}
              onChange={(v) => setForm((p) => ({ ...p, title: v }))}
              featureEnabled={baseFieldCustomizationEnabled}
              organizationId={organizationId}
              userId={user?.id}
              id="admin-exp-title"
              placeholder={t("form.placeholders.title", { ns: "expenses" })}
              defaultControl={
                <Input
                  id="admin-exp-title"
                  value={form.title}
                  onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                  placeholder={t("form.placeholders.title", { ns: "expenses" })}
                />
              }
            />
          </div>

          <div className={cn("space-y-2", !destinationField.is_visible && "hidden")}>
            <Label htmlFor="admin-exp-destination">{destinationField.label}{destinationField.is_required ? " *" : ""}</Label>
            <BaseExpenseFieldInput
              config={destinationField}
              value={form.destination}
              onChange={(v) => setForm((p) => ({ ...p, destination: v }))}
              featureEnabled={baseFieldCustomizationEnabled}
              organizationId={organizationId}
              userId={user?.id}
              id="admin-exp-destination"
              placeholder={t("form.placeholders.destination", { ns: "expenses" })}
              defaultControl={
                <Input
                  id="admin-exp-destination"
                  value={form.destination}
                  onChange={(e) => setForm((p) => ({ ...p, destination: e.target.value }))}
                  placeholder={t("form.placeholders.destination", { ns: "expenses" })}
                />
              }
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className={cn("space-y-2", !dateField.is_visible && "hidden")}>
              <Label>{dateField.label}{dateField.is_required ? " *" : ""}</Label>
              <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(date, "PPP")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={(d) => { if (d) { setDate(d); setDatePickerOpen(false); } }}
                    disabled={(d) => d > new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className={cn("space-y-2", !amountField.is_visible && "hidden")}>
              <Label>{amountField.label}{amountField.is_required ? " *" : ""}</Label>
              <BaseExpenseFieldInput
                config={amountField}
                value={form.amount}
                onChange={(v) => setForm((p) => ({ ...p, amount: v }))}
                featureEnabled={baseFieldCustomizationEnabled}
                organizationId={organizationId}
                userId={user?.id}
                placeholder={t("form.placeholders.amount", { ns: "expenses" })}
                defaultControl={
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={form.amount}
                    onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                    placeholder={t("form.placeholders.amount", { ns: "expenses" })}
                  />
                }
              />
            </div>
          </div>

          <div className={cn("space-y-2", !purposeField.is_visible && "hidden")}>
            <Label htmlFor="admin-exp-purpose">{purposeField.label}{purposeField.is_required ? " *" : ""}</Label>
            <BaseExpenseFieldInput
              config={purposeField}
              value={form.purpose}
              onChange={(v) => setForm((p) => ({ ...p, purpose: v }))}
              featureEnabled={baseFieldCustomizationEnabled}
              organizationId={organizationId}
              userId={user?.id}
              id="admin-exp-purpose"
              placeholder={t("form.placeholders.purpose", { ns: "expenses" })}
              defaultControl={
                <Textarea
                  id="admin-exp-purpose"
                  value={form.purpose}
                  onChange={(e) => setForm((p) => ({ ...p, purpose: e.target.value }))}
                  placeholder={t("form.placeholders.purpose", { ns: "expenses" })}
                  rows={3}
                />
              }
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={handleSubmitClick} disabled={!canSubmit}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          {t("submitForEmployee.submit", { ns: "admin" })}
        </Button>
        <Button variant="outline" onClick={() => navigate("/dashboard")} disabled={submitting}>
          {t("cancel", { ns: "common" })}
        </Button>
      </div>

      {lastCreatedExpense && (
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Expense created for <strong>{lastCreatedExpense.employeeName}</strong> — optionally attach a receipt.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setLastCreatedExpense(null)}>Dismiss</Button>
            </div>
            <FileUpload expenseId={lastCreatedExpense.expenseId} required={false} />
          </CardContent>
        </Card>
      )}

      <SubmitStatusChoiceDialog
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
        subjectLabel="this expense"
        confirming={confirmingStatusChoice}
        onConfirm={(status, comment) => void performSubmit(status, comment)}
      />
    </div>
        </TabsContent>

        <TabsContent value="bulk" className="mt-4">
          <BulkExpenseImportPanel
            organizationId={organizationId}
            employees={employees}
            categories={categories}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <AdminExpenseHistoryTab organizationId={organizationId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
