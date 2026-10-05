import { useCallback, useMemo, useRef, useState } from "react";
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
 * INCIDENT hotfix (Project Unique ID / Project ID / Project Name data loss,
 * 2026-09) — a bare `isLoading`/`hasError` boolean pair let a PENDING fetch
 * present identically to "this template has zero conditional fields",
 * because callers gated on `optionBranches.length > 0` rather than on
 * whether the config for the CURRENTLY selected value was actually known.
 * Combined with no request-generation tracking, a slow response for an
 * option the user had already navigated away from could also overwrite a
 * newer, already-resolved selection ("latest-selection-wins" was not
 * guaranteed).
 *
 * This version tracks an explicit per-template status keyed by
 * (templateId, optionValue):
 *   - "unconfigured": nothing selected for this template (no fetch needed)
 *   - "loading": a fetch for `forValue` is in flight
 *   - "ready": `forValue`'s branches are known and current
 *   - "error": the most recent fetch for `forValue` failed
 *
 * `isResolvedFor(templateId, value)` is the primitive callers MUST use to
 * gate rendering/validation/submission — it is only true when the config is
 * actually known for the EXACT value currently selected, never inferred from
 * an empty array. A generation counter per template discards any fetch
 * result that resolves after a newer selection for that same template has
 * already started, so the config a caller sees always belongs to the last
 * value it actually selected (latest-selection-wins), regardless of network
 * ordering.
 *
 * The returned `optionBranches` array keeps the exact same shape
 * (OptionBranchDefinition[]) the rest of the conditional-field rendering
 * pipeline (getVisibleBranches, buildInitialBranchValues, etc.) already
 * expects — nothing downstream needs to change to keep working, though
 * callers should migrate validation/submission gating to `isResolvedFor`.
 */
export type OptionBranchLoadState = "unconfigured" | "loading" | "ready" | "error";

export type OptionBranchStatus = {
  state: OptionBranchLoadState;
  /** The option value this status (and, once ready, the branches) belong to. */
  forValue: string | null;
};

const UNCONFIGURED_STATUS: OptionBranchStatus = { state: "unconfigured", forValue: null };

export function useOnDemandOptionBranches(organizationId: string | null | undefined) {
  const [branchesByTemplate, setBranchesByTemplate] = useState<Record<string, OptionBranchDefinition[]>>({});
  const [statusByTemplate, setStatusByTemplate] = useState<Record<string, OptionBranchStatus>>({});
  const cacheRef = useRef<Map<string, OptionBranchDefinition[]>>(new Map());
  // Per-template monotonic counter. Incremented synchronously on every
  // selectOptionValue call so a fetch that resolves after a NEWER selection
  // for the same template has already started can detect it's stale and
  // discard its own result instead of clobbering the newer one.
  const generationRef = useRef<Record<string, number>>({});

  const cacheKey = (templateId: string, optionValue: string) => `${templateId}::${optionValue}`;

  /** Call when the user selects (or the form pre-populates) a value for a
   *  select-type template — fetches that option's branches on demand and
   *  merges them into the flat optionBranches array under that template. */
  const selectOptionValue = useCallback(
    async (templateId: string, optionValue: string) => {
      const myGeneration = (generationRef.current[templateId] ?? 0) + 1;
      generationRef.current[templateId] = myGeneration;

      if (!optionValue) {
        setBranchesByTemplate((prev) => ({ ...prev, [templateId]: [] }));
        setStatusByTemplate((prev) => ({ ...prev, [templateId]: UNCONFIGURED_STATUS }));
        return;
      }

      const key = cacheKey(templateId, optionValue);
      const cached = cacheRef.current.get(key);
      if (cached) {
        setBranchesByTemplate((prev) => ({ ...prev, [templateId]: cached }));
        setStatusByTemplate((prev) => ({ ...prev, [templateId]: { state: "ready", forValue: optionValue } }));
        return;
      }

      if (!organizationId) {
        // Nothing to fetch against yet; leave the template unresolved rather
        // than silently reporting "ready with zero branches" — the caller
        // must keep treating this template as not-yet-configured.
        setStatusByTemplate((prev) => ({ ...prev, [templateId]: { state: "loading", forValue: optionValue } }));
        return;
      }

      setStatusByTemplate((prev) => ({ ...prev, [templateId]: { state: "loading", forValue: optionValue } }));
      const result = await fetchRuntimeOptionBranches(supabase, organizationId, templateId, optionValue);

      // Latest-selection-wins: if this template has moved on to a newer
      // selection while this request was in flight, this result is stale —
      // discard it entirely rather than writing it into current state.
      if (generationRef.current[templateId] !== myGeneration) return;

      if (!result.error) {
        cacheRef.current.set(key, result.branches);
      }
      setBranchesByTemplate((prev) => ({ ...prev, [templateId]: result.error ? [] : result.branches }));
      setStatusByTemplate((prev) => ({
        ...prev,
        [templateId]: { state: result.error ? "error" : "ready", forValue: optionValue },
      }));
    },
    [organizationId],
  );

  /** Clears all cached/loaded branches — call when the category/template
   *  assignment itself changes, so stale branches from a previous category
   *  never leak into the newly-selected one. */
  const reset = useCallback(() => {
    setBranchesByTemplate({});
    setStatusByTemplate({});
    generationRef.current = {};
  }, []);

  const optionBranches: OptionBranchDefinition[] = useMemo(
    () => Object.values(branchesByTemplate).flat(),
    [branchesByTemplate],
  );

  /** True when the config for `templateId`'s CURRENT value `optionValue` is
   *  known and current. False for "no value selected" only when it's exactly
   *  what a caller wants ("nothing to resolve" is treated as resolved) — for
   *  submission gating callers should call this once per currently-selected
   *  select-type template with that template's current value, not once for
   *  the section as a whole. Never infers "resolved" from an empty array. */
  const isResolvedFor = useCallback(
    (templateId: string, optionValue: string | null | undefined): boolean => {
      if (!optionValue) return true;
      const status = statusByTemplate[templateId];
      return !!status && status.state === "ready" && status.forValue === optionValue;
    },
    [statusByTemplate],
  );

  /** True when `templateId`'s current value failed to load. */
  const hasErrorFor = useCallback(
    (templateId: string, optionValue: string | null | undefined): boolean => {
      if (!optionValue) return false;
      const status = statusByTemplate[templateId];
      return !!status && status.state === "error" && status.forValue === optionValue;
    },
    [statusByTemplate],
  );

  /** True when `templateId`'s current value is still being fetched. */
  const isLoadingFor = useCallback(
    (templateId: string, optionValue: string | null | undefined): boolean => {
      if (!optionValue) return false;
      const status = statusByTemplate[templateId];
      return !!status && status.state === "loading" && status.forValue === optionValue;
    },
    [statusByTemplate],
  );

  /** True when ANY tracked template's most recent fetch failed. Coarse —
   *  prefer hasErrorFor(templateId, value) for precise per-field gating. */
  const hasError = Object.values(statusByTemplate).some((s) => s.state === "error");
  /** True when ANY tracked template has a fetch in flight. Coarse — prefer
   *  isLoadingFor(templateId, value) for precise per-field gating. */
  const isLoading = Object.values(statusByTemplate).some((s) => s.state === "loading");

  return {
    optionBranches,
    selectOptionValue,
    reset,
    isLoading,
    hasError,
    statusByTemplate,
    isResolvedFor,
    hasErrorFor,
    isLoadingFor,
  };
}
