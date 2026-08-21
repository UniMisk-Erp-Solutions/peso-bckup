/**
 * DOC-097/DOC-100 — search + pagination state machine for the server-paged
 * parent-option editor.
 *
 * UI-parity fix (DOC-100): main's Parent Options / Dependent Fields search
 * boxes are a live filter — type and results update, no Search button.
 * Server-paged mode can't replay that as a literal client-side filter (that
 * would require the whole option list in memory, exactly what this hotfix
 * exists to avoid), so it's approximated with a DEBOUNCED auto-search: the
 * search fires ~300ms after the user stops typing, not per keystroke, not
 * only on an explicit action. Visually indistinguishable from a live filter
 * at normal typing speed; still exactly one request per pause, not one per
 * character.
 *
 * Contract:
 *   - Opening the section auto-loads page 1 of the UNFILTERED browse
 *     (query=null) exactly ONCE per template -- matching the Expenses page's
 *     own "open tab, page 1 loads automatically" UX. A ref-guarded effect
 *     (not a plain mount effect) ensures this fires exactly once even under
 *     React StrictMode's double-invoke, and again exactly once if the admin
 *     navigates to a DIFFERENT template.
 *   - Typing debounces to one auto-search ~300ms after the last keystroke.
 *   - runSearch() (Enter) submits immediately, bypassing the debounce.
 *   - searchInput (what's currently typed) is tracked separately from
 *     submittedSearch (what was actually queried); changing page reuses
 *     submittedSearch, never whatever unsent text is mid-debounce.
 *   - clearSearch() returns to the unfiltered browse at page 1, same as the
 *     initial auto-load.
 *   - A stale response can never overwrite a newer one: every fetch is
 *     tagged with a monotonically increasing generation number, and a
 *     response is only applied if it's still the latest issued generation
 *     by the time it resolves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  searchFormTemplateParentOptions,
  type SearchPage,
} from "@/lib/formBuilder/categoryServerSearchV2";

export type SearchLoadState = "idle" | "loading" | "success" | "error";

const SEARCH_DEBOUNCE_MS = 300;

export type UseServerPagedOptionSearchResult = {
  /** Raw text currently in the search box. Typing debounces to an
   *  auto-search; it doesn't fire a request on every keystroke. */
  searchInput: string;
  setSearchInput: (v: string) => void;
  /** The query that was actually last submitted to the server. */
  submittedSearch: string | null;
  loadState: SearchLoadState;
  error: string | null;
  page: SearchPage | null;
  pageSize: number;
  setPageSize: (n: number) => void;
  configuredOnly: boolean;
  setConfiguredOnly: (v: boolean) => void;
  /** Submits searchInput immediately (e.g. on Enter), bypassing the debounce. */
  runSearch: () => void;
  /** Fetches a different page of the CURRENT submittedSearch (not searchInput). */
  goToPage: (pageNumber: number) => void;
  retry: () => void;
  /** Clears the search box and submitted query, returning to the unfiltered
   *  browse at page 1 -- same request shape as the initial auto-load. */
  clearSearch: () => void;
};

export function useServerPagedOptionSearch(
  organizationId: string | null,
  templateId: string | null,
): UseServerPagedOptionSearchResult {
  const [searchInput, setSearchInputState] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<SearchLoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [pageSize, setPageSizeState] = useState(25);
  const [configuredOnly, setConfiguredOnlyState] = useState(false);

  // Race safety: only the response matching the latest issued generation is applied.
  const generationRef = useRef(0);
  // Guards the auto-load-on-open effect to exactly one browse request per
  // template -- keyed by templateId so re-renders (including React
  // StrictMode's deliberate double-invoke in development) never issue a
  // second logical request, but opening a DIFFERENT template does.
  const autoLoadedForTemplateRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPage = useCallback(
    (query: string | null, pageNumber: number, size: number, confOnly: boolean) => {
      if (!organizationId || !templateId) return;
      const myGeneration = ++generationRef.current;
      setLoadState("loading");
      setError(null);

      searchFormTemplateParentOptions(organizationId, templateId, query, pageNumber, size, confOnly)
        .then((result) => {
          if (myGeneration !== generationRef.current) return; // superseded by a newer search
          setPage(result);
          setLoadState("success");
        })
        .catch((e: unknown) => {
          if (myGeneration !== generationRef.current) return;
          setLoadState("error");
          setError(e instanceof Error ? e.message : "Search failed.");
        });
    },
    [organizationId, templateId],
  );

  const submitQuery = useCallback(
    (rawInput: string) => {
      const trimmed = rawInput.trim();
      const query = trimmed === "" ? null : trimmed;
      setSubmittedSearch(query);
      fetchPage(query, 1, pageSize, configuredOnly);
    },
    [pageSize, configuredOnly, fetchPage],
  );

  const setSearchInput = useCallback(
    (v: string) => {
      setSearchInputState(v);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => submitQuery(v), SEARCH_DEBOUNCE_MS);
    },
    // submitQuery is recreated when pageSize/configuredOnly change, which is
    // exactly when a new debounced search SHOULD pick up the latest values.
    [submitQuery],
  );

  const runSearch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    submitQuery(searchInput);
  }, [searchInput, submitQuery]);

  const goToPage = useCallback(
    (pageNumber: number) => {
      // Deliberately uses submittedSearch, NOT searchInput — changing page must
      // never silently start querying unsent text the user typed afterward.
      fetchPage(submittedSearch, pageNumber, pageSize, configuredOnly);
    },
    [submittedSearch, pageSize, configuredOnly, fetchPage],
  );

  const setPageSize = useCallback(
    (n: number) => {
      setPageSizeState(n);
      if (submittedSearch !== null || page !== null) {
        fetchPage(submittedSearch, 1, n, configuredOnly);
      }
    },
    [submittedSearch, page, configuredOnly, fetchPage],
  );

  const setConfiguredOnly = useCallback(
    (v: boolean) => {
      setConfiguredOnlyState(v);
      fetchPage(submittedSearch, 1, pageSize, v);
    },
    [submittedSearch, pageSize, fetchPage],
  );

  const retry = useCallback(() => {
    fetchPage(submittedSearch, page?.page ?? 1, pageSize, configuredOnly);
  }, [submittedSearch, page, pageSize, configuredOnly, fetchPage]);

  const clearSearch = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setSearchInputState("");
    setSubmittedSearch(null);
    fetchPage(null, 1, pageSize, configuredOnly);
  }, [pageSize, configuredOnly, fetchPage]);

  // Auto-load page 1 of the unfiltered browse exactly once per template --
  // matches the Expenses page's "open tab, page 1 loads automatically" UX.
  useEffect(() => {
    if (!organizationId || !templateId) return;
    if (autoLoadedForTemplateRef.current === templateId) return;
    autoLoadedForTemplateRef.current = templateId;
    fetchPage(null, 1, pageSize, configuredOnly);
    // Deliberately excludes pageSize/configuredOnly/fetchPage from deps --
    // this effect must fire exactly once per templateId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, templateId]);

  // Flush any pending debounce on unmount so it never fires after the
  // component (and its callbacks' closures) are gone.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return {
    searchInput,
    setSearchInput,
    submittedSearch,
    loadState,
    error,
    page,
    pageSize,
    setPageSize,
    configuredOnly,
    setConfiguredOnly,
    runSearch,
    goToPage,
    retry,
    clearSearch,
  };
}
