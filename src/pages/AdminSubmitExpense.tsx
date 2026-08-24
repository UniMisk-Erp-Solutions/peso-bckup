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
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { Check, ChevronsUpDown, CalendarIcon, Loader2, Send, UserRoundSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { fetchOrganizationUsers, type OrganizationUserRow } from "@/lib/orgUsers";
import { userMatchesManagementSearch } from "@/lib/approvalHierarchy";
import { submitExpenseForEmployee } from "@/lib/adminSubmitExpense";
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

const emptyForm = {
  title: "",
  destination: "",
  purpose: "",
  category: "",
  amount: "",
};

export default function AdminSubmitExpense() {
  const { t } = useTranslation(["admin", "expenses", "common"]);
  const { organizationId } = useAuth();
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
  };

  const canSubmit =
    Boolean(organizationId) &&
    Boolean(selectedEmployee) &&
    form.title.trim() !== "" &&
    form.destination.trim() !== "" &&
    form.category.trim() !== "" &&
    Number(form.amount) > 0 &&
    !submitting;

  const handleSubmit = async () => {
    if (!organizationId || !selectedEmployee) return;
    const amount = Number(form.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: t("submitForEmployee.errors.amount", { ns: "admin" }),
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

      toast({
        title: t("submitForEmployee.success.title", { ns: "admin" }),
        description: t("submitForEmployee.success.description", {
          ns: "admin",
          name: selectedEmployee.name || selectedEmployee.email,
        }),
      });

      resetForm();
      void result;
    } catch (err) {
      toast({
        title: t("submitForEmployee.errors.title", { ns: "admin" }),
        description: err instanceof Error ? err.message : t("submitForEmployee.errors.generic", { ns: "admin" }),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
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
        </TabsList>

        <TabsContent value="single" className="mt-4">
    <div className="max-w-2xl space-y-6">
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
          <div className="space-y-2">
            <Label htmlFor="admin-exp-title">{t("form.fields.title", { ns: "expenses" })}</Label>
            <Input
              id="admin-exp-title"
              value={form.title}
              onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
              placeholder={t("form.placeholders.title", { ns: "expenses" })}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-exp-destination">{t("form.fields.destination", { ns: "expenses" })}</Label>
            <Input
              id="admin-exp-destination"
              value={form.destination}
              onChange={(e) => setForm((p) => ({ ...p, destination: e.target.value }))}
              placeholder={t("form.placeholders.destination", { ns: "expenses" })}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("form.fields.expenseDate", { ns: "expenses" })}</Label>
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

            <div className="space-y-2">
              <Label>{t("form.fields.amount", { ns: "expenses" })}</Label>
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.amount}
                onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))}
                placeholder={t("form.placeholders.amount", { ns: "expenses" })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("form.fields.category", { ns: "expenses" })}</Label>
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
                          onSelect={() => { setForm((p) => ({ ...p, category: c })); setCategoryPickerOpen(false); }}
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
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-exp-purpose">{t("form.fields.purpose", { ns: "expenses" })}</Label>
            <Textarea
              id="admin-exp-purpose"
              value={form.purpose}
              onChange={(e) => setForm((p) => ({ ...p, purpose: e.target.value }))}
              placeholder={t("form.placeholders.purpose", { ns: "expenses" })}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
          {t("submitForEmployee.submit", { ns: "admin" })}
        </Button>
        <Button variant="outline" onClick={() => navigate("/dashboard")} disabled={submitting}>
          {t("cancel", { ns: "common" })}
        </Button>
      </div>
    </div>
        </TabsContent>

        <TabsContent value="bulk" className="mt-4">
          <BulkExpenseImportPanel
            organizationId={organizationId}
            employees={employees}
            categories={categories}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
