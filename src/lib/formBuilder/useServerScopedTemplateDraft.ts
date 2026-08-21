import { useCallback, useMemo, useRef, useState } from "react";
import {
  getFormTemplateParentOptionConfigurationsBatch,
  saveFormTemplateParentOptionConfigurationsBatchAtomically,
  type DraftOptionBranchV2,
  type OptionConfiguration,
  type BatchSaveEntry,
  type BatchSaveEntryResult,
} from "@/lib/formBuilder/categoryServerSearchV2";

/**
 * The scalable draft model for bulk import / Matrix / presets on a
 * server-paged (large) template: instead of downloading every option's
 * branches up front, this hook is a bounded CACHE of whichever options have
 * actually been touched (opened, imported, edited in Matrix, targeted by a
 * preset) plus an OVERLAY of pending unsaved edits keyed by parent option
 * value. Switching pages, tabs or the current option never discards a
 * pending edit — it stays in the overlay until saved or explicitly
 * discarded. Only options someone actually interacted with are ever held in
 * memory; the rest of a 5,000-option template is never fetched.
 */
export function useServerScopedTemplateDraft(
  organizationId: string | null | undefined,
  templateId: string | null | undefined,
) {
  const [loaded, setLoaded] = useState<Map<string, OptionConfiguration>>(new Map());
  const [overlay, setOverlay] = useState<Map<string, DraftOptionBranchV2[]>>(new Map());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [errorsByKey, setErrorsByKey] = useState<Map<string, string>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());
  // Mirrors `loaded` synchronously — `setLoaded` is async (a later render),
  // so a caller that awaits ensureLoaded() and then immediately needs the
  // freshly-fetched data (e.g. DropdownBulkImportDialog's resolver, which
  // must return real branches the instant the promise resolves) cannot rely
  // on `loaded` from its own render closure. ensureLoaded reads/writes this
  // ref directly and returns the resolved data itself, so no caller ever
  // needs to guess whether a state update has landed yet.
  const loadedRef = useRef<Map<string, OptionConfiguration>>(new Map());

  /** Batch-fetches whichever of `optionValues` aren't already cached or
   *  in flight, then returns EVERY requested value's current
   *  DraftOptionBranchV2[] (freshly fetched or already cached) — safe to
   *  use immediately after the returned promise resolves, unlike reading
   *  the hook's own `loaded` state back in the same tick. Safe to call
   *  repeatedly (e.g. on every page change); a no-op fetch for anything
   *  already loaded. */
  const ensureLoaded = useCallback(
    async (optionValues: string[]): Promise<Map<string, DraftOptionBranchV2[]>> => {
      const result = new Map<string, DraftOptionBranchV2[]>();
      if (!organizationId || !templateId) return result;

      const need = optionValues.filter(
        (v) => v.trim() !== "" && !loadedRef.current.has(v) && !inFlightRef.current.has(v),
      );
      if (need.length > 0) {
        need.forEach((v) => inFlightRef.current.add(v));
        setLoadingKeys((prev) => new Set([...prev, ...need]));
        try {
          const configs = await getFormTemplateParentOptionConfigurationsBatch(organizationId, templateId, need);
          for (const c of configs) loadedRef.current.set(c.parentOptionValue, c);
          setLoaded(new Map(loadedRef.current));
          setErrorsByKey((prev) => {
            const next = new Map(prev);
            need.forEach((v) => next.delete(v));
            return next;
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "Could not load these options.";
          setErrorsByKey((prev) => {
            const next = new Map(prev);
            need.forEach((v) => next.set(v, message));
            return next;
          });
          throw e;
        } finally {
          need.forEach((v) => inFlightRef.current.delete(v));
          setLoadingKeys((prev) => {
            const next = new Set(prev);
            need.forEach((v) => next.delete(v));
            return next;
          });
        }
      }

      for (const v of optionValues) {
        result.set(v, loadedRef.current.get(v)?.drafts ?? []);
      }
      return result;
    },
    [organizationId, templateId],
  );

  const getDrafts = useCallback(
    (optionValue: string): DraftOptionBranchV2[] => overlay.get(optionValue) ?? loaded.get(optionValue)?.drafts ?? [],
    [overlay, loaded],
  );

  const getFingerprint = useCallback(
    (optionValue: string): string | null => loaded.get(optionValue)?.configurationFingerprint ?? null,
    [loaded],
  );

  const isLoaded = useCallback((optionValue: string) => loaded.has(optionValue), [loaded]);

  const setDraft = useCallback((optionValue: string, drafts: DraftOptionBranchV2[]) => {
    setOverlay((prev) => {
      const next = new Map(prev);
      next.set(optionValue, drafts);
      return next;
    });
  }, []);

  /** Regroups a flat "next branchDrafts" array (as returned by
   *  DropdownBulkImportDialog's onApply, or by MatrixEditorPanel's
   *  setBranchDrafts / PresetToolbar's onApplyPreset) back into
   *  per-option overlays — every one of those callers already scopes its
   *  input/output to just the touched options, so this never needs to
   *  reason about anything beyond what's in `drafts`. */
  const setOverlayFromMergedDrafts = useCallback((drafts: DraftOptionBranchV2[]) => {
    const byOption = new Map<string, DraftOptionBranchV2[]>();
    for (const d of drafts) {
      const list = byOption.get(d.parent_option_value) ?? [];
      list.push(d);
      byOption.set(d.parent_option_value, list);
    }
    setOverlay((prev) => {
      const next = new Map(prev);
      for (const [option, list] of byOption) next.set(option, list);
      return next;
    });
  }, []);

  const clearDraft = useCallback((optionValue: string) => {
    setOverlay((prev) => {
      const next = new Map(prev);
      next.delete(optionValue);
      return next;
    });
  }, []);

  const isDirty = useCallback((optionValue: string) => overlay.has(optionValue), [overlay]);
  const dirtyOptionValues = useMemo(() => Array.from(overlay.keys()), [overlay]);

  /** Persists every currently-dirty option in `optionValues` (defaults to
   *  ALL dirty options) via the batch-save RPC. Each option succeeds or
   *  fails independently; on success its overlay is cleared and its cache
   *  entry invalidated so the next ensureLoaded() re-fetches the fresh
   *  fingerprint. Returns the per-option results so the caller can surface
   *  partial failures. */
  const saveDirty = useCallback(
    async (
      newOptionValues: string[] = [],
      optionValues?: string[],
      source?: string,
      reason?: string,
    ): Promise<{ newOptionsAdded: number; results: BatchSaveEntryResult[] }> => {
      if (!organizationId || !templateId) return { newOptionsAdded: 0, results: [] };
      const targets = optionValues ?? dirtyOptionValues;
      const entries: BatchSaveEntry[] = targets
        .filter((v) => overlay.has(v))
        .map((v) => ({
          parentOptionValue: v,
          expectedFingerprint: getFingerprint(v),
          drafts: overlay.get(v)!,
        }));
      if (entries.length === 0 && newOptionValues.length === 0) {
        return { newOptionsAdded: 0, results: [] };
      }
      const { newOptionsAdded, results } = await saveFormTemplateParentOptionConfigurationsBatchAtomically(
        organizationId,
        templateId,
        newOptionValues,
        entries,
        source,
        reason,
      );
      const okValues = new Set(results.filter((r) => r.status === "ok").map((r) => r.parentOptionValue));
      setOverlay((prev) => {
        const next = new Map(prev);
        okValues.forEach((v) => next.delete(v));
        return next;
      });
      okValues.forEach((v) => loadedRef.current.delete(v)); // force a fresh fetch (new fingerprint) next time it's needed
      setLoaded(new Map(loadedRef.current));
      return { newOptionsAdded, results };
    },
    [organizationId, templateId, overlay, dirtyOptionValues, getFingerprint],
  );

  const reset = useCallback(() => {
    loadedRef.current = new Map();
    setLoaded(new Map());
    setOverlay(new Map());
    setLoadingKeys(new Set());
    setErrorsByKey(new Map());
    inFlightRef.current.clear();
  }, []);

  return {
    ensureLoaded,
    getDrafts,
    getFingerprint,
    isLoaded,
    setDraft,
    setOverlayFromMergedDrafts,
    clearDraft,
    isDirty,
    dirtyOptionValues,
    saveDirty,
    loadingKeys,
    errorsByKey,
    reset,
  };
}

export type ServerScopedTemplateDraft = ReturnType<typeof useServerScopedTemplateDraft>;
