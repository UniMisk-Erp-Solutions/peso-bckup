/**
 * useBatchFieldPlan — fetches all form field assignments for categories in the batch,
 * then builds a coherent BatchFieldPlan (deduped by template ID, not category name).
 *
 * One fetch per unique set of category IDs — no per-line N+1 queries.
 *
 * COLUMN NOTE: expense_form_field_templates uses `required` (not `is_required`) and
 * has no `label` column (the field name is stored in `name`). Selecting non-existent
 * columns causes PostgREST to reject the entire nested query, returning null assignments
 * and producing an empty plan. This hook only selects columns that genuinely exist.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  buildBatchFieldPlan,
  getActiveCategoryIds,
} from "@/lib/batchFieldPlan";
import type { BatchFieldAssignment, BatchFieldPlan } from "@/lib/batchFieldPlan";

export type UseBatchFieldPlanResult = {
  plan: BatchFieldPlan;
  categoryIdByName: Record<string, string>;
  loading: boolean;
  /**
   * Non-null when the last assignment fetch failed.
   * Distinct from `plan.shared.length === 0` (which means no fields are configured).
   */
  error: Error | null;
  /** Call to re-run the fetch after an error without changing categories. */
  reload: () => void;
};

const EMPTY_PLAN: BatchFieldPlan = { shared: [], perLine: [] };

export function useBatchFieldPlan(
  organizationId: string | null | undefined,
  /** Category names present in the current batch */
  categoryNames: string[],
): UseBatchFieldPlanResult {
  const [allAssignments, setAllAssignments] = useState<BatchFieldAssignment[]>([]);
  const [categoryIdByName, setCategoryIdByName] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => setReloadCount((n) => n + 1), []);

  // Stable key: sorted, deduped category names
  const categoryKey = useMemo(
    () => [...new Set(categoryNames.map((c) => c.trim()).filter(Boolean))].sort().join("|"),
    [categoryNames],
  );

  // Track whether we had a successful load so we can retain the previous plan on error.
  const hadSuccessRef = useRef(false);

  useEffect(() => {
    if (!organizationId || !categoryKey) {
      setAllAssignments([]);
      setCategoryIdByName({});
      setError(null);
      hadSuccessRef.current = false;
      return;
    }

    const uniqueCategories = categoryKey.split("|");
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        // Step 1: Resolve category names → IDs
        const { data: catRows, error: catError } = await supabase
          .from("expense_categories")
          .select("id, name")
          .eq("organization_id", organizationId)
          .in("name", uniqueCategories);

        if (cancelled) return;

        if (catError) {
          const err = new Error(catError.message);
          console.error("[useBatchFieldPlan] category lookup failed:", catError.code);
          setError(err);
          // Retain previous assignments so the form keeps existing shared fields.
          return;
        }

        const nameToId: Record<string, string> = {};
        for (const row of catRows ?? []) {
          if (row.name && row.id) nameToId[row.name] = row.id;
        }
        setCategoryIdByName(nameToId);

        const categoryIds = Object.values(nameToId);
        if (categoryIds.length === 0) {
          setAllAssignments([]);
          setError(null);
          hadSuccessRef.current = true;
          return;
        }

        // Step 2: Fetch all assignments for those category IDs in one query.
        //
        // IMPORTANT: only select columns that actually exist in the DB.
        //   - expense_form_field_templates.required  (boolean, NOT is_required)
        //   - expense_form_field_templates.name       (text, NOT label)
        //   - expense_form_field_templates.batch_entry_mode (added in migration 20260716120000)
        const { data: assignments, error: assignmentsError } = await supabase
          .from("expense_category_form_fields")
          .select(
            `
            id,
            category_id,
            required,
            display_order,
            show_on_submit,
            ask_once_per_batch,
            expense_form_field_templates (
              id, name, field_type, required, placeholder,
              help_text, options, show_on_submit, batch_entry_mode
            )
          `,
          )
          .eq("organization_id", organizationId)
          .in("category_id", categoryIds)
          .order("display_order", { ascending: true });

        if (cancelled) return;

        if (assignmentsError) {
          const err = new Error(assignmentsError.message);
          console.error("[useBatchFieldPlan] assignment fetch failed:", assignmentsError.code);
          setError(err);
          // Do NOT clear allAssignments — retain the previous plan.
          return;
        }

        // Flatten the nested template relation and attach category name.
        const idToName: Record<string, string> = Object.fromEntries(
          Object.entries(nameToId).map(([n, id]) => [id, n]),
        );

        const mapped: BatchFieldAssignment[] = (assignments ?? []).map((a) => ({
          ...a,
          category_name: idToName[a.category_id] ?? null,
          template:
            (a as { expense_form_field_templates?: BatchFieldAssignment["template"] })
              .expense_form_field_templates ?? { id: "" },
        }));

        setAllAssignments(mapped);
        setError(null);
        hadSuccessRef.current = true;
      } catch (caught) {
        if (cancelled) return;
        const err = caught instanceof Error ? caught : new Error(String(caught));
        console.error("[useBatchFieldPlan] unexpected error:", err.message);
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // reloadCount intentionally triggers a re-fetch without changing categoryKey
  }, [organizationId, categoryKey, reloadCount]);

  const plan = useMemo(() => {
    if (allAssignments.length === 0) return EMPTY_PLAN;
    const activeIds = getActiveCategoryIds(
      categoryNames.map((c) => ({ category: c })),
      categoryIdByName,
    );
    return buildBatchFieldPlan(allAssignments, activeIds);
  }, [allAssignments, categoryNames, categoryIdByName]);

  return { plan, categoryIdByName, loading, error, reload };
}
