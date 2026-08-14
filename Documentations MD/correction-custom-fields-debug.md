# DEBUG: Custom Form Fields Not Showing in Correction Dialog

**Date:** 2026-07-07  
**Project:** PesoWise (expense management SaaS)  
**Stack:** React + TypeScript + Supabase (PostgreSQL + PostgREST)  
**Issue:** "Correct expense" dialog does not show custom form field inputs, even for expenses that have custom field values stored.

---

## What the feature is supposed to do

When a reviewer (manager/admin) clicks "Correct expense" on an employee's expense, a dialog opens. This dialog should show:
- Standard base fields (title, destination, date, purpose, category, amount, admin comment)
- **Custom form fields** — org-defined fields the employee filled when submitting (e.g. "Vehicle Number", "Project Name", odometer reading, etc.)

The reviewer should be able to edit those custom values and save them.

---

## Data model (relevant tables)

```sql
-- Defines what custom fields exist for an org
expense_form_field_templates (
  id uuid PK,
  organization_id uuid,
  name text,           -- e.g. "Vehicle Number"
  field_key text,
  field_type text,     -- 'text' | 'number' | 'date' | 'textarea' | 'select' | 'checkbox'
  required boolean,
  created_at timestamptz
  -- NOTE: NO display_order column on this table
  -- display_order lives on expense_category_form_fields instead
)

-- Actual saved values per expense
expense_form_field_values (
  id uuid PK,
  expense_id uuid FK → expenses.id,
  organization_id uuid,
  template_id uuid FK → expense_form_field_templates.id,  -- nullable
  branch_field_id uuid FK → expense_form_field_option_branches.id,  -- nullable
  field_value text,
  created_at timestamptz
)
-- Constraint: exactly one of template_id or branch_field_id is set per row.
-- Template rows = standard custom fields; branch rows = conditional sub-fields.
```

---

## What code was written (the implementation)

### 1. `ExpenseService.applyExpenseCorrectionByReviewer` — new optional parameter

```typescript
static async applyExpenseCorrectionByReviewer(
  expenseId: string,
  editorUserId: string,
  updates: ExpenseCorrectionUpdates,
  reason?: string | null,
  customFieldValues?: Record<string, string>,  // NEW: templateId → value
): Promise<void> {
  // ... existing RPC call for base fields ...

  // NEW: upsert custom field values
  if (customFieldValues && Object.keys(customFieldValues).length > 0) {
    const entries = Object.entries(customFieldValues).filter(([, val]) => val.trim() !== "");
    if (entries.length > 0) {
      const templateIds = entries.map(([tid]) => tid);
      const { data: existing } = await supabase
        .from("expense_form_field_values")
        .select("id, template_id")
        .eq("expense_id", expenseId)
        .eq("organization_id", organizationId)
        .in("template_id", templateIds);
      const existingMap = new Map(
        (existing ?? []).map((r) => [r.template_id as string, r.id as string]),
      );
      await Promise.all(
        entries.map(([templateId, value]) =>
          existingMap.has(templateId)
            ? supabase.from("expense_form_field_values")
                .update({ field_value: value.trim() })
                .eq("id", existingMap.get(templateId)!)
            : supabase.from("expense_form_field_values")
                .insert({
                  expense_id: expenseId,
                  organization_id: organizationId,
                  template_id: templateId,
                  branch_field_id: null,
                  field_value: value.trim(),
                }),
        ),
      );
    }
  }
}
```

### 2. `openCorrectionDialog` in `EngineerReview.tsx` — current version (3rd attempt)

```typescript
const openCorrectionDialog = async () => {
  if (!selectedExpense) return;
  // ... set base fields ...
  setCorrCustomFields({});
  setCorrCustomFieldTemplates([]);

  // Step 1: find what custom field VALUES this expense has
  const { data: existingValues } = await supabase
    .from("expense_form_field_values")
    .select("template_id, field_value")
    .eq("expense_id", selectedExpense.id)
    .not("template_id", "is", null);

  if (existingValues && existingValues.length > 0) {
    const templateIds = existingValues.map((v) => v.template_id as string).filter(Boolean);

    // Step 2: get the template definitions for those IDs
    const { data: templates } = await supabase
      .from("expense_form_field_templates")
      .select("id, name, field_type")
      .in("id", templateIds);

    if (templates && templates.length > 0) {
      setCorrCustomFieldTemplates(templates as Array<{ id: string; name: string; field_type: string }>);
      const valMap: Record<string, string> = {};
      for (const row of existingValues) {
        if (row.template_id) valMap[String(row.template_id)] = String(row.field_value ?? "");
      }
      setCorrCustomFields(valMap);
    }
  }

  setCorrectionDialogOpen(true);
};
```

### 3. Dialog JSX — the section that renders (only if templates found)

```tsx
{corrCustomFieldTemplates.length > 0 && (
  <div className="border-t pt-3 space-y-3">
    <p className="text-xs font-medium text-muted-foreground">Custom form fields</p>
    {corrCustomFieldTemplates.map((tmpl) => (
      <div key={tmpl.id}>
        <Label htmlFor={`eng-corr-cf-${tmpl.id}`}>{tmpl.name}</Label>
        <Input
          id={`eng-corr-cf-${tmpl.id}`}
          type={tmpl.field_type === "number" ? "number" : "text"}
          value={corrCustomFields[tmpl.id] ?? ""}
          onChange={(e) =>
            setCorrCustomFields((prev) => ({ ...prev, [tmpl.id]: e.target.value }))
          }
        />
      </div>
    ))}
  </div>
)}
```

---

## What was tried (chronological failures)

### Attempt 1 — `.order("display_order")` on templates
**Code:** Queried `expense_form_field_templates` with `.order("display_order", { ascending: true })`  
**Failure:** PostgREST returned HTTP 400 — `display_order` column doesn't exist on this table (it lives on `expense_category_form_fields`). `data` was null → section not shown.

### Attempt 2 — `.order("created_at")` + org filter
**Code:** Fixed to `.order("created_at", ...)` + `.eq("organization_id", organizationId)`  
**Failure:** Section still not shown. Either the org has no templates, or the org_id filter was wrong.

### Attempt 3 — Query values first, then templates by those IDs (current)
**Code:** As above — first get `expense_form_field_values` for the expense, then fetch templates by those IDs.  
**Failure:** Still not showing. The section only renders if `corrCustomFieldTemplates.length > 0`, which means either Step 1 returns 0 rows, or Step 2 returns 0 templates.

---

## Diagnostic SQL — run these in Supabase SQL editor

Replace `'<EXPENSE_UUID>'` with the actual expense ID (get it from the URL when viewing the expense).

```sql
-- Q1: Does this expense have ANY custom field values saved?
SELECT id, expense_id, organization_id, template_id, branch_field_id, field_value
FROM expense_form_field_values
WHERE expense_id = '<EXPENSE_UUID>'
ORDER BY created_at;

-- Q2: Are there template-based values specifically? (step 1 of the fetch)
SELECT template_id, field_value
FROM expense_form_field_values
WHERE expense_id = '<EXPENSE_UUID>'
  AND template_id IS NOT NULL;

-- Q3: What do the templates look like for this org?
SELECT id, name, field_type, created_at
FROM expense_form_field_templates
WHERE organization_id = '<ORG_UUID>'
ORDER BY created_at;

-- Q4: Full join — what values + labels exist for this expense?
SELECT v.template_id, v.branch_field_id, v.field_value,
       t.name AS template_name, t.field_type,
       b.name AS branch_name
FROM expense_form_field_values v
LEFT JOIN expense_form_field_templates t ON t.id = v.template_id
LEFT JOIN expense_form_field_option_branches b ON b.id = v.branch_field_id
WHERE v.expense_id = '<EXPENSE_UUID>';

-- Q5: RLS check — can the reviewer role see values?
-- Run as the reviewer's user (use Supabase RLS simulation or check policies)
SELECT COUNT(*) FROM expense_form_field_values
WHERE expense_id = '<EXPENSE_UUID>';

-- Q6: What RLS policies exist on expense_form_field_values?
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'expense_form_field_values';
```

---

## Most likely root causes (for GPT to investigate)

1. **No data in DB** — Q1 returns 0 rows. The expense was submitted before the upsert-index fix and values were never saved. In this case, no code change will make them appear — the data doesn't exist. The user would need to re-submit the expense or manually INSERT the rows.

2. **RLS blocking the reviewer** — Q1 returns rows when run as superuser but returns 0 when run as the reviewer's session. The existing RLS policy (`20260621120000`) grants read access to "expense owner, assigned engineer, org admin". A hierarchy reviewer (TL/executive/manager who isn't the assigned engineer) may still be blocked.

3. **All values are branch-based, not template-based** — Q1 returns rows but Q2 returns 0. The employee filled conditional sub-fields (branch fields, `branch_field_id IS NOT NULL`), not top-level template fields. The current code only fetches `template_id IS NOT NULL` rows. Branch fields need a different lookup path (`expense_form_field_option_branches` instead of `expense_form_field_templates`).

4. **Template fetch returning empty** — Q3 returns 0. The org truly has no templates configured, or they're on a different org_id. Without templates, there are no custom fields to edit.

---

## What the correct fix looks like (suggestions for GPT)

**If root cause is #3 (branch fields):** The fetch needs to also include `branch_field_id IS NOT NULL` rows and look up their labels via `expense_form_field_option_branches`. The template type could be inferred as "text" by default.

**If root cause is #2 (RLS):** Add/update the RLS policy on `expense_form_field_values` so that hierarchy reviewers who can see the parent `expenses` row can also read the form field values:

```sql
CREATE POLICY "Reviewers can view form field values"
ON public.expense_form_field_values FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_form_field_values.expense_id
      AND (
        e.user_id = auth.uid()
        OR e.assigned_engineer_id = auth.uid()
        OR e.assigned_reviewer_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.organization_memberships om
          WHERE om.user_id = auth.uid()
            AND om.organization_id = e.organization_id
            AND om.role IN ('admin', 'manager')
            AND om.is_active = true
        )
      )
  )
);
```

**If root cause is #1 (no data):** Run diagnostic Q4 for the specific expense the user is testing. If 0 rows, the feature works correctly — there are simply no saved custom field values to display or edit.

---

## Key files

```
src/pages/EngineerReview.tsx               — openCorrectionDialog (async), corrCustomFieldTemplates state, dialog JSX
src/components/BatchExpenseReviewPanel.tsx — loadCustomFieldsForExpense helper, same pattern
src/services/ExpenseService.ts             — applyExpenseCorrectionByReviewer (customFieldValues param + upsert)
```

---

## Question to investigate

**The core question is:** When `openCorrectionDialog` runs for the expense "BHARUCH ROOOM TO RIL DMD SITE":

1. Does the Supabase query `expense_form_field_values?expense_id=eq.<UUID>&template_id=not.is.null` return any rows?
2. If not, are there rows with `branch_field_id IS NOT NULL` instead?
3. Or does the query return 0 rows entirely (data was never saved)?

Run Q1 and Q2 from the diagnostic section above to answer this definitively.
