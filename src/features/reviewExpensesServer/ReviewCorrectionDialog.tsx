/**
 * Correct expense (on behalf of employee).
 *
 * Ported from origin/main:src/pages/EngineerReview.tsx (`openCorrectionDialog` /
 * `submitExpenseCorrection` at ~L1643-1740 and the dialog at ~L3218-3300). The
 * previous server page omitted this entirely and withheld the button; that was
 * a real gap, not a simplification.
 *
 * Everything load-bearing is main's own code, unchanged:
 * `loadCorrectionCustomFields`, `validateCorrectionCustomFields`,
 * `getVisibleBranchIds`, `buildCorrectionCustomFieldPatch`,
 * `CorrectionCustomFieldsSection` and `ExpenseCategorySelect`. Nested
 * conditional fields therefore behave exactly as they do on main, including
 * required-field validation and branch pruning.
 *
 * The one substitution is the write path: main called
 * `ExpenseService.applySingularExpenseCorrection` directly, this goes through
 * the shared action layer so the feature flag, the toast handling and the query
 * invalidation stay in one place.
 *
 * A validation failure keeps the dialog open with every entered value intact —
 * main's behaviour, and the reason `open` never resets state on its own.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ExpenseCategorySelect } from "@/components/ExpenseCategorySelect";
import { CorrectionCustomFieldsSection } from "@/components/CorrectionCustomFieldsSection";
import { supabase } from "@/integrations/supabase/client";
import {
  EMPTY_CORRECTION_FIELDS,
  loadCorrectionCustomFields,
  validateCorrectionCustomFields,
  fetchCorrectionOptionBranches,
  mergeCorrectionOptionBranches,
  type CorrectionCustomFieldsModel,
} from "@/lib/loadCorrectionCustomFields";
import { getVisibleBranchIds } from "@/lib/conditionalFormFields";
import { buildCorrectionCustomFieldPatch } from "@/lib/buildCorrectionCustomFieldPatch";
import { useOrganizationExpenseFormConfig } from "@/hooks/useOrganizationExpenseFormConfig";
import type { ActionableExpense, CorrectionInput } from "@/features/reviewActions/types";

export type CorrectionSeed = {
  expense: ActionableExpense;
  title: string;
  destination: string;
  expenseDate: string;
  purpose: string;
  category: string;
  amount: string;
  adminComment: string;
};

export function ReviewCorrectionDialog({
  open,
  onOpenChange,
  seed,
  organizationId,
  allowNestedConditional,
  saving,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Current values of the expense being corrected. Null while none is open. */
  seed: CorrectionSeed | null;
  organizationId: string | null;
  allowNestedConditional: boolean;
  saving: boolean;
  /** Returns true on success, so the dialog knows whether it may close. */
  onSubmit: (expense: ActionableExpense, input: CorrectionInput) => Promise<boolean>;
}) {
  const { getFieldLabel: getBaseFieldLabel } = useOrganizationExpenseFormConfig(organizationId);

  const [title, setTitle] = useState("");
  const [destination, setDestination] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [purpose, setPurpose] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [adminComment, setAdminComment] = useState("");
  const [reason, setReason] = useState("");
  const [fieldModel, setFieldModel] = useState<CorrectionCustomFieldsModel>({
    ...EMPTY_CORRECTION_FIELDS,
  });
  const [error, setError] = useState<string | null>(null);
  const [loadingFields, setLoadingFields] = useState(false);

  const expenseId = seed?.expense.id ?? null;

  /**
   * Seed from the expense, then load its custom-field model — main's
   * `openCorrectionDialog`, keyed on the expense so reopening a different row
   * never inherits the previous one's values.
   */
  useEffect(() => {
    if (!open || !seed) return;
    setTitle(seed.title);
    setDestination(seed.destination);
    setExpenseDate(seed.expenseDate);
    setPurpose(seed.purpose);
    setCategory(seed.category);
    setAmount(seed.amount);
    setAdminComment(seed.adminComment);
    setReason("");
    setError(null);
    setFieldModel({ ...EMPTY_CORRECTION_FIELDS });

    if (!seed.category || !organizationId || !expenseId) return;
    let cancelled = false;
    setLoadingFields(true);
    void loadCorrectionCustomFields(supabase, organizationId, expenseId, seed.category)
      .then((model) => {
        if (!cancelled) setFieldModel(model);
      })
      .finally(() => {
        if (!cancelled) setLoadingFields(false);
      });
    return () => {
      cancelled = true;
    };
    // Seeding is intentionally keyed on the expense, not on every seed identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expenseId, organizationId]);

  /** DOC-100 pt.2: the reviewer changing a parent select's value mid-correction
   *  must load that option's tree on demand -- the initial load only ever
   *  fetched whichever value was SAVED when the dialog opened. */
  const handleSelectOptionValue = useCallback(
    async (templateId: string, optionValue: string) => {
      if (!organizationId || !optionValue) return;
      const result = await fetchCorrectionOptionBranches(supabase, organizationId, templateId, optionValue);
      setFieldModel((prev) => ({
        ...prev,
        optionBranches: mergeCorrectionOptionBranches(prev.optionBranches, templateId, result.branches),
        loadError: result.error
          ? "Could not load additional field configuration for the selected option. Please retry."
          : undefined,
      }));
    },
    [organizationId],
  );

  const submit = useCallback(async () => {
    if (!seed) return;
    setError(null);

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError("Amount must be a positive number");
      return;
    }

    if (fieldModel.loadError) {
      setError(fieldModel.loadError);
      return;
    }

    const validation = validateCorrectionCustomFields(
      fieldModel.categoryFormFields,
      fieldModel.formFieldValues,
      fieldModel.optionBranches,
      fieldModel.branchValues,
      allowNestedConditional,
    );
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    const visibleBranchIds = getVisibleBranchIds(
      fieldModel.optionBranches,
      fieldModel.formFieldValues,
      fieldModel.branchValues,
      allowNestedConditional,
    );
    const patch =
      fieldModel.categoryFormFields.length > 0
        ? buildCorrectionCustomFieldPatch(fieldModel, visibleBranchIds)
        : [];

    const ok = await onSubmit(seed.expense, {
      updates: {
        title: title.trim(),
        destination: destination.trim(),
        // One date is stored for the expense, as on the employee form.
        trip_start: expenseDate,
        trip_end: expenseDate,
        purpose: purpose.trim() || null,
        category: category.trim() || null,
        total_amount: amt,
        admin_comment: adminComment.trim() || null,
      },
      reason: reason.trim() || null,
      customFieldPatch: patch,
    });

    // Only a confirmed success closes; a refusal keeps every entered value.
    if (ok) onOpenChange(false);
  }, [
    seed,
    amount,
    fieldModel,
    allowNestedConditional,
    onSubmit,
    title,
    destination,
    expenseDate,
    purpose,
    category,
    adminComment,
    reason,
    onOpenChange,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg max-h-[90vh] overflow-y-auto"
        data-testid="review-correction-dialog"
      >
        <DialogHeader>
          <DialogTitle>Correct expense (on behalf of employee)</DialogTitle>
          <DialogDescription>
            Saves an audit record and sets status to adjusted. The employee still sees this
            expense as in review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div>
            <Label htmlFor="rev-corr-title">{getBaseFieldLabel("title")}</Label>
            <Input
              id="rev-corr-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="correction-title"
            />
          </div>
          <div>
            <Label htmlFor="rev-corr-dest">{getBaseFieldLabel("destination")}</Label>
            <Input
              id="rev-corr-dest"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              data-testid="correction-destination"
            />
          </div>
          <div>
            <Label htmlFor="rev-corr-date">{getBaseFieldLabel("expense_date")}</Label>
            <Input
              id="rev-corr-date"
              type="date"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              data-testid="correction-date"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Same as the employee expense form — one date is stored for this expense.
            </p>
          </div>
          <div>
            <Label htmlFor="rev-corr-pur">{getBaseFieldLabel("purpose")}</Label>
            <Textarea
              id="rev-corr-pur"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <Label htmlFor="rev-corr-cat">{getBaseFieldLabel("category")}</Label>
            <ExpenseCategorySelect
              id="rev-corr-cat"
              organizationId={organizationId}
              value={category}
              onChange={setCategory}
            />
          </div>
          <div>
            <Label htmlFor="rev-corr-amt">{getBaseFieldLabel("amount")}</Label>
            <Input
              id="rev-corr-amt"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              data-testid="correction-amount"
            />
          </div>
          <div>
            <Label htmlFor="rev-corr-ac">Admin comment</Label>
            <Textarea
              id="rev-corr-ac"
              value={adminComment}
              onChange={(e) => setAdminComment(e.target.value)}
              rows={2}
            />
          </div>

          {fieldModel.loadError && (
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              {fieldModel.loadError}
            </p>
          )}

          <CorrectionCustomFieldsSection
            categoryFormFields={fieldModel.categoryFormFields}
            formFieldValues={fieldModel.formFieldValues}
            onFormFieldValuesChange={(vals) =>
              setFieldModel((prev) => ({ ...prev, formFieldValues: vals }))
            }
            optionBranches={fieldModel.optionBranches}
            branchValues={fieldModel.branchValues}
            onBranchValuesChange={(vals) =>
              setFieldModel((prev) => ({ ...prev, branchValues: vals }))
            }
            allowNested={allowNestedConditional}
            organizationId={organizationId}
            onSelectOptionValue={handleSelectOptionValue}
          />

          <div>
            <Label htmlFor="rev-corr-reason">Reason for correction (audit)</Label>
            <Textarea
              id="rev-corr-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              data-testid="correction-reason"
            />
          </div>

          {error && (
            <p
              className="text-xs text-destructive border border-destructive/40 rounded px-2 py-1"
              data-testid="correction-error"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || loadingFields}
            data-testid="correction-save"
          >
            {saving ? "Saving…" : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
