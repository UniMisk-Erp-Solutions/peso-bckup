/**
 * DOC-097 hotfix — on-demand parent-option configuration loading.
 *
 * Opening the editor loads ZERO branch rows. Selecting a specific parent
 * option triggers exactly one fetch for that option's own tree. Already-
 * loaded options are cached for the remainder of the open editor session —
 * selecting one option, then another, then back to the first does not
 * re-fetch the first unless explicitly refreshed.
 *
 * A failed fetch leaves the option in an "error" state with no synthesized
 * empty configuration — the caller must not allow Save while in that state.
 */
import { useCallback, useRef, useState } from "react";
import {
  getFormTemplateParentOptionConfiguration,
  type DraftOptionBranchV2,
  type OptionConfiguration,
} from "@/lib/formBuilder/categoryServerSearchV2";

export type OptionLoadState = "idle" | "loading" | "success" | "error";

export type UseOptionConfigurationResult = {
  selectedOption: string | null;
  loadState: OptionLoadState;
  error: string | null;
  /** The loaded option's drafts — only meaningful when loadState === "success". */
  drafts: DraftOptionBranchV2[];
  /** The fingerprint to pass back into the save RPC. */
  fingerprint: string | null;
  /** Selects (and, unless cached, fetches) a parent option's configuration. */
  selectOption: (optionValue: string) => void;
  /** Clears the current selection, returning to the search results view. */
  clearSelection: () => void;
  /** Re-fetches the currently-selected option, bypassing the cache. */
  retry: () => void;
  /** Lets the caller (after a successful save) update local drafts/fingerprint
   *  without a round-trip, and refresh the cache entry to match. */
  applyLocalUpdate: (drafts: DraftOptionBranchV2[], fingerprint: string) => void;
  /** For the local editor state the user is actively editing (separate from
   *  the last-loaded-from-server snapshot, so edits don't get clobbered by
   *  an unrelated cache hit). */
  setDrafts: (drafts: DraftOptionBranchV2[]) => void;
};

export function useOptionConfiguration(
  organizationId: string | null,
  templateId: string | null,
): UseOptionConfigurationResult {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<OptionLoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDraftsState] = useState<DraftOptionBranchV2[]>([]);
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  const cacheRef = useRef<Map<string, OptionConfiguration>>(new Map());
  const generationRef = useRef(0);

  const load = useCallback(
    (optionValue: string, bypassCache: boolean) => {
      if (!organizationId || !templateId) return;

      const cached = !bypassCache ? cacheRef.current.get(optionValue) : undefined;
      if (cached) {
        setDraftsState(cached.drafts);
        setFingerprint(cached.configurationFingerprint);
        setLoadState("success");
        setError(null);
        return;
      }

      const myGeneration = ++generationRef.current;
      setLoadState("loading");
      setError(null);

      getFormTemplateParentOptionConfiguration(organizationId, templateId, optionValue)
        .then((config) => {
          if (myGeneration !== generationRef.current) return;
          cacheRef.current.set(optionValue, config);
          setDraftsState(config.drafts);
          setFingerprint(config.configurationFingerprint);
          setLoadState("success");
        })
        .catch((e: unknown) => {
          if (myGeneration !== generationRef.current) return;
          setLoadState("error");
          setError(e instanceof Error ? e.message : "Configuration could not be loaded.");
        });
    },
    [organizationId, templateId],
  );

  const selectOption = useCallback(
    (optionValue: string) => {
      setSelectedOption(optionValue);
      load(optionValue, false);
    },
    [load],
  );

  const clearSelection = useCallback(() => {
    generationRef.current++; // invalidate any in-flight fetch so it can never "revive" state after navigating away
    setSelectedOption(null);
    setLoadState("idle");
    setError(null);
    setDraftsState([]);
    setFingerprint(null);
  }, []);

  const retry = useCallback(() => {
    if (!selectedOption) return;
    load(selectedOption, true);
  }, [selectedOption, load]);

  const applyLocalUpdate = useCallback(
    (nextDrafts: DraftOptionBranchV2[], nextFingerprint: string) => {
      if (!selectedOption) return;
      cacheRef.current.set(selectedOption, {
        parentOptionValue: selectedOption,
        drafts: nextDrafts,
        configurationFingerprint: nextFingerprint,
      });
      setDraftsState(nextDrafts);
      setFingerprint(nextFingerprint);
    },
    [selectedOption],
  );

  return {
    selectedOption,
    loadState,
    error,
    drafts,
    fingerprint,
    selectOption,
    clearSelection,
    retry,
    applyLocalUpdate,
    setDrafts: setDraftsState,
  };
}
