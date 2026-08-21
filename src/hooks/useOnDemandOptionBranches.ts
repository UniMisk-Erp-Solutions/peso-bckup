import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { fetchRuntimeOptionBranches } from "@/lib/runtimeOptionBranches";
import type { OptionBranchDefinition } from "@/lib/conditionalFormFieldTypes";

/**
 * DOC-097 hotfix pt.3 — replaces the eager, unbounded
 * ExpenseService.fetchOptionBranchesForTemplates(organizationId, selectIds)
 * (which downloads EVERY active branch for EVERY select-type template
 * assigned to a category, regardless of which option is actually selected —
 * the exact pattern that silently truncates past PostgREST's ~1,000-row cap)
 * with an on-demand fetch of exactly the SELECTED option's own branch tree,
 * via the read-only, employee-safe get_runtime_form_option_configuration
 * RPC (see fetchRuntimeOptionBranches). Bounded cache keyed by
 * (template, option) so re-selecting an already-opened option is instant and
 * never re-fetched.
 *
 * The returned `optionBranches` array has the exact same shape
 * (OptionBranchDefinition[]) the rest of the conditional-field rendering
 * pipeline (getVisibleBranches, buildInitialBranchValues, etc.) already
 * expects — nothing downstream needs to change.
 */
export function useOnDemandOptionBranches(organizationId: string | null | undefined) {
  const [branchesByTemplate, setBranchesByTemplate] = useState<Record<string, OptionBranchDefinition[]>>({});
  // DOC-100 pt.2: tracks which templates' most recent fetch FAILED (RPC error),
  // as distinct from a template that genuinely has zero child branches. A failed
  // fetch must never look like "no conditional fields exist" to a caller gating
  // submission.
  const [errorByTemplate, setErrorByTemplate] = useState<Record<string, boolean>>({});
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, OptionBranchDefinition[]>>(new Map());

  const cacheKey = (templateId: string, optionValue: string) => `${templateId}::${optionValue}`;

  const fetchOption = useCallback(
    async (templateId: string, optionValue: string): Promise<{ branches: OptionBranchDefinition[]; error: boolean }> => {
      if (!organizationId || !optionValue) return { branches: [], error: false };
      const key = cacheKey(templateId, optionValue);
      const cached = cacheRef.current.get(key);
      if (cached) return { branches: cached, error: false };

      setLoadingKey(key);
      try {
        const result = await fetchRuntimeOptionBranches(supabase, organizationId, templateId, optionValue);
        if (!result.error) {
          cacheRef.current.set(key, result.branches);
        }
        return result;
      } finally {
        setLoadingKey((cur) => (cur === key ? null : cur));
      }
    },
    [organizationId],
  );

  /** Call when the user selects (or the form pre-populates) a value for a
   *  select-type template — fetches that option's branches on demand and
   *  merges them into the flat optionBranches array under that template. */
  const selectOptionValue = useCallback(
    async (templateId: string, optionValue: string) => {
      if (!optionValue) {
        setBranchesByTemplate((prev) => ({ ...prev, [templateId]: [] }));
        setErrorByTemplate((prev) => ({ ...prev, [templateId]: false }));
        return;
      }
      const { branches, error } = await fetchOption(templateId, optionValue);
      setBranchesByTemplate((prev) => ({ ...prev, [templateId]: branches }));
      setErrorByTemplate((prev) => ({ ...prev, [templateId]: error }));
    },
    [fetchOption],
  );

  /** Clears all cached/loaded branches — call when the category/template
   *  assignment itself changes, so stale branches from a previous category
   *  never leak into the newly-selected one. */
  const reset = useCallback(() => {
    setBranchesByTemplate({});
    setErrorByTemplate({});
  }, []);

  const optionBranches: OptionBranchDefinition[] = Object.values(branchesByTemplate).flat();
  /** True when the MOST RECENT fetch for any currently-selected template failed.
   *  Callers must block submission while this is true rather than treating the
   *  associated conditional fields as "none configured". */
  const hasError = Object.values(errorByTemplate).some(Boolean);

  return { optionBranches, selectOptionValue, reset, isLoading: loadingKey !== null, hasError };
}
