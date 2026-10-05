/**
 * Admin submits an expense on behalf of an employee.
 *
 * Architecture: this page is a thin UI over admin_submit_expense_for_employee_v2
 * (see that migration's header for the full atomicity/idempotency rationale).
 * It reuses the employee's own field engine (CategoryFormFieldsSection,
 * BaseExpenseFieldInput, useOnDemandOptionBranches, expenseFormConfig) rather
 * than forking it, and the employee's own receipt primitives (FileUpload,
 * finalize-expense-receipts) rather than inventing a second upload path.
 *
 * Identity model: `selectedEmployee` is the SUBJECT (whose expense this is —
 * becomes expenses.user_id, the routing basis, the notification recipient,
 * the balance-deduction target). The signed-in admin (useAuth().user) is the
 * ACTOR (auth.uid() inside the RPC, the audit actor, the uploader). These are
 * never conflated anywhere in this file.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { fetchOrganizationUsers, type OrganizationUserRow } from "@/lib/orgUsers";
import { userMatchesManagementSearch } from "@/lib/approvalHierarchy";
import {
  loadOrganizationExpenseFieldConfig,
  categoryFormFieldsForName,
  type OrganizationExpenseFieldConfig,
} from "@/lib/orgExpenseFieldConfig";
import { useOnDemandOptionBranches } from "@/hooks/useOnDemandOptionBranches";
import { getVisibleBranchIds, validateVisibleBranchFields } from "@/lib/conditionalFormFields";
import { CategoryFormFieldsSection } from "@/components/CategoryFormFieldsSection";
import { BaseExpenseFieldInput } from "@/components/BaseExpenseFieldInput";
import { FileUpload } from "@/components/FileUpload";
import { SubmitStatusChoiceDialog } from "@/components/SubmitStatusChoiceDialog";
import { AdminExpenseHistoryTab } from "@/components/AdminExpenseHistoryTab";
import { BulkExpenseImportPanel } from "@/components/BulkExpenseImportPanel";
import {
  submitExpenseForEmployee,
  finalizePendingReceiptsForExpense,
  AdminSubmitExpenseError,
  type AdminSubmitStatusChoice,
  type CustomFieldValuePayload,
} from "@/lib/adminSubmitExpense";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function newIdempotencyKey(): string {
  return `single:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export default function AdminSubmitExpense() {
  const { user, organizationId } = useAuth();
  const { toast } = useToast();

  const [employees, setEmployees] = useState<OrganizationUserRow[]>([]);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedEmployee, setSelectedEmployee] = useState<OrganizationUserRow | null>(null);

  const [config, setConfig] = useState<OrganizationExpenseFieldConfig | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [tripStart, setTripStart] = useState("");
  const [tripEnd, setTripEnd] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);

  const [formFieldValues, setFormFieldValues] = useState<Record<string, string>>({});
  const [branchValues, setBranchValues] = useState<Record<string, string>>({});
  const {
    optionBranches,
    selectOptionValue,
    reset: resetOptionBranches,
    hasError: optionBranchLoadError,
    isResolvedFor,
    isLoadingFor,
    hasErrorFor,
  } = useOnDemandOptionBranches(organizationId);

  const [pendingReceipts, setPendingReceipts] = useState<
    Array<{ filename: string; contentType?: string; fileSize?: number }>
  >([]);

  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey());

  useEffect(() => {
    if (!organizationId) return;
    void fetchOrganizationUsers(organizationId).then(setEmployees).catch(() => setEmployees([]));
    void loadOrganizationExpenseFieldConfig(organizationId).then((cfg) => {
      setConfig(cfg);
      setCategories([...cfg.categoriesById.keys()]);
    });
  }, [organizationId]);

  const filteredEmployees = useMemo(
    () =>
      employees.filter(
        (e) =>
          e.user_id !== user?.id &&
          userMatchesManagementSearch({ name: e.name, email: e.email, employee_id: e.employee_id, role: e.role }, employeeSearch),
      ),
    [employees, employeeSearch, user?.id],
  );

  const categoryFormFields = useMemo(
    () => (config && category ? categoryFormFieldsForName(config, category) : []),
    [config, category],
  );

  function resetForm() {
    setTitle("");
    setDestination("");
    setTripStart("");
    setTripEnd("");
    setCategory("");
    setAmount("");
    setPurpose("");
    setFormFieldValues({});
    setBranchValues({});
    resetOptionBranches();
    setPendingReceipts([]);
    setIdempotencyKey(newIdempotencyKey());
  }

  function handleCategoryChange(next: string) {
    setCategory(next);
    setFormFieldValues({});
    setBranchValues({});
    resetOptionBranches();
  }

  async function handleAddCategory() {
    const name = newCategoryName.trim();
    if (!name || !organizationId) return;
    try {
      // No isAdmin gate needed (unlike the employee form): this entire page
      // is already admin-only (route allowedRoles=["admin"]). Category
      // creation is still its own capability, enforced server-side by
      // whatever RLS the expense_categories table already applies to an
      // admin insert — submitting an expense does not, by itself, imply
      // category-management permission; it happens to be the same role
      // today because this codebase's current policy grants org admins both.
      let { error } = await db
        .from("expense_categories")
        .insert({ name, active: true, organization_id: organizationId, created_by: user?.id || null });
      if (error && error.code === "42703") {
        const retry = await db
          .from("expense_categories")
          .insert({ name, is_active: true, organization_id: organizationId, created_by: user?.id || null });
        error = retry.error;
      }
      if (error) throw error;
      setCategories((prev) => Array.from(new Set([...prev, name])));
      setNewCategoryName("");
      setAddCategoryOpen(false);
      toast({ title: "Category added", description: `"${name}" is now available to select.` });
      if (organizationId) void loadOrganizationExpenseFieldConfig(organizationId).then(setConfig);
    } catch (err) {
      toast({
        title: "Could not add category",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  /**
   * INCIDENT hotfix (2026-09): this used to read branch definitions from
   * `optionBranchesForTemplates(config!, templateIds)` — the org-wide eager
   * config, unfiltered by which option value is actually selected. That is a
   * DIFFERENT, disagreeing source of truth from the on-demand `optionBranches`
   * this same page renders with, and — critically — is not scoped by
   * `getVisibleBranchIds`/parent_option_value at all, so a stale/orphaned
   * branch value left over from a previously-selected option (or belonging
   * to an option nobody chose) could get persisted alongside the real
   * answer. Building the payload from the SAME on-demand `optionBranches` +
   * `getVisibleBranchIds` the
   * other two submission paths (ExpenseForm, ExpenseBatchForm) already use
   * makes this one canonical mechanism instead of a fourth divergent one.
   */
  function buildCustomFieldPayload(): CustomFieldValuePayload[] {
    const values: CustomFieldValuePayload[] = [];
    for (const { template } of categoryFormFields) {
      const value = formFieldValues[template.id];
      if (value !== undefined && value !== "") {
        values.push({ template_id: template.id, field_value: value });
      }
    }
    const visibleBranchIds = getVisibleBranchIds(optionBranches, formFieldValues, branchValues, false);
    for (const branchId of visibleBranchIds) {
      const value = branchValues[branchId];
      if (value !== undefined && value !== "") {
        values.push({ branch_field_id: branchId, field_value: value });
      }
    }
    return values;
  }

  /**
   * Canonical requiredness rule proven from existing code/tests (assignment
   * override falls back to the template's own required flag) — reproduced
   * here rather than guessed. See BatchLineFormFields.tsx, correctionCustomFields
   * CC-5/CC-6, expenseBatchValidation.ts for the same rule elsewhere.
   */
  function customFieldValidationError(): string | null {
    if (optionBranchLoadError) {
      return "Could not load additional field configuration for the selected option. Please retry before submitting.";
    }
    for (const field of categoryFormFields) {
      const templateId = field.template.id;
      const value = formFieldValues[templateId];
      if (field.template.field_type === "select" && value) {
        if (!isResolvedFor(templateId, value)) {
          return "Loading additional field configuration — please wait a moment and try again.";
        }
        if (hasErrorFor(templateId, value)) {
          return "Could not load additional field configuration for the selected option. Please retry before submitting.";
        }
      }
      const effectiveRequired = field.required ?? field.template.required;
      if (effectiveRequired && !value) {
        return `${field.template.name} is required.`;
      }
    }
    const branchValidation = validateVisibleBranchFields(optionBranches, formFieldValues, branchValues, false);
    if (!branchValidation.valid) {
      return `Please complete: ${branchValidation.missing.join(", ")}`;
    }
    return null;
  }

  async function performSubmit(status: AdminSubmitStatusChoice, comment: string) {
    if (!organizationId || !selectedEmployee) return;
    // INCIDENT hotfix (2026-09): this page previously had ZERO required
    // custom-field validation — canSubmit only checked the base fields. A
    // required Project ID/Project Name (or any other required custom field)
    // could be submitted empty with no error at all.
    const validationError = customFieldValidationError();
    if (validationError) {
      toast({ title: "Additional fields required", description: validationError, variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitExpenseForEmployee({
        organizationId,
        employeeId: selectedEmployee.user_id,
        title,
        destination,
        tripStart,
        tripEnd,
        category,
        amount: Number(amount),
        purpose: purpose || null,
        customFieldValues: buildCustomFieldPayload(),
        status,
        statusComment: comment || null,
        idempotencyKey,
      });

      let receiptSummary = "";
      if (pendingReceipts.length > 0 && user) {
        const outcome = await finalizePendingReceiptsForExpense({
          expenseId: result.expenseId,
          organizationId,
          adminUserId: user.id,
          receipts: pendingReceipts,
        });
        if (outcome.failedCount > 0) {
          receiptSummary = ` ${outcome.attachmentsInserted}/${pendingReceipts.length} receipt(s) attached — ${outcome.failedCount} pending, retry from the expense detail page.`;
        } else if (outcome.pendingCount > 0) {
          receiptSummary = ` Receipts attached (${outcome.pendingCount} awaiting final storage confirmation).`;
        } else {
          receiptSummary = ` ${outcome.attachmentsInserted} receipt(s) attached.`;
        }
      }

      toast({
        title: result.idempotentReplay ? "Already submitted" : "Expense submitted",
        description: `Expense created for ${selectedEmployee.name}, status: ${result.status}.${receiptSummary}`,
      });
      resetForm();
      setSelectedEmployee(null);
      setStatusDialogOpen(false);
    } catch (err) {
      const message =
        err instanceof AdminSubmitExpenseError ? `${err.code}: ${err.message}` : "Failed to submit expense";
      toast({ title: "Submission failed", description: message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!selectedEmployee && title.trim() && destination.trim() && category.trim() && Number(amount) > 0 && tripStart && tripEnd;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <h1 className="text-2xl font-semibold">Submit expense for an employee</h1>

      <Tabs defaultValue="single">
        <TabsList>
          <TabsTrigger value="single">Single submission</TabsTrigger>
          <TabsTrigger value="bulk">Bulk import</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent value="single" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Employee</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                placeholder="Search by name, email, or employee ID…"
                value={employeeSearch}
                onChange={(e) => setEmployeeSearch(e.target.value)}
              />
              {selectedEmployee ? (
                <div className="flex items-center justify-between rounded-md border p-2">
                  <span>
                    {selectedEmployee.name} ({selectedEmployee.employee_id ?? selectedEmployee.email})
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedEmployee(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-md border">
                  {filteredEmployees.slice(0, 50).map((e) => (
                    <button
                      key={e.user_id}
                      type="button"
                      className="block w-full px-3 py-2 text-left hover:bg-muted"
                      onClick={() => setSelectedEmployee(e)}
                    >
                      {e.name} ({e.employee_id ?? e.email})
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Expense details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="title">Title</Label>
                <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="destination">Destination</Label>
                <Input id="destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label htmlFor="trip-start">Trip start</Label>
                  <Input id="trip-start" type="date" value={tripStart} onChange={(e) => setTripStart(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="trip-end">Trip end</Label>
                  <Input id="trip-end" type="date" value={tripEnd} onChange={(e) => setTripEnd(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="category">Category</Label>
                <div className="flex gap-2">
                  <select
                    id="category"
                    className="flex-1 rounded-md border px-3 py-2"
                    value={category}
                    onChange={(e) => handleCategoryChange(e.target.value)}
                  >
                    <option value="">Select a category…</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <Dialog open={addCategoryOpen} onOpenChange={setAddCategoryOpen}>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add category</DialogTitle>
                      </DialogHeader>
                      <Input
                        value={newCategoryName}
                        onChange={(e) => setNewCategoryName(e.target.value)}
                        placeholder="Category name"
                      />
                      <Button onClick={() => void handleAddCategory()}>Add</Button>
                    </DialogContent>
                  </Dialog>
                  <Button type="button" variant="outline" onClick={() => setAddCategoryOpen(true)}>
                    + Category
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="amount">Amount</Label>
                <Input id="amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="purpose">Purpose</Label>
                <Textarea id="purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </div>

              {config && category && (
                <CategoryFormFieldsSection
                  categoryFormFields={categoryFormFields}
                  formFieldValues={formFieldValues}
                  onFormFieldValuesChange={setFormFieldValues}
                  optionBranches={optionBranches}
                  branchValues={branchValues}
                  onBranchValuesChange={setBranchValues}
                  allowNested={false}
                  organizationId={organizationId}
                  userId={selectedEmployee?.user_id}
                  onSelectOptionValue={(templateId, value) => void selectOptionValue(templateId, value)}
                  instanceId="admin-submit"
                  isOptionResolved={isResolvedFor}
                  isOptionLoading={isLoadingFor}
                  isOptionErrored={hasErrorFor}
                />
              )}

              <div className="space-y-1.5">
                <Label>Receipts (optional)</Label>
                <FileUpload
                  expenseId="new"
                  onUploadComplete={(attachment) => {
                    const filename = (attachment.storage_path ?? "").split("/").pop() ?? attachment.filename;
                    setPendingReceipts((prev) => [
                      ...prev,
                      { filename, contentType: attachment.content_type, fileSize: attachment.file_size },
                    ]);
                  }}
                />
              </div>
            </CardContent>
          </Card>

          <Button size="lg" disabled={!canSubmit || submitting} onClick={() => setStatusDialogOpen(true)}>
            Continue
          </Button>

          <SubmitStatusChoiceDialog
            open={statusDialogOpen}
            onOpenChange={setStatusDialogOpen}
            onConfirm={(status, comment) => void performSubmit(status, comment)}
            submitting={submitting}
          />
        </TabsContent>

        <TabsContent value="bulk">{organizationId && <BulkExpenseImportPanel organizationId={organizationId} />}</TabsContent>

        <TabsContent value="history">
          <AdminExpenseHistoryTab organizationId={organizationId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
