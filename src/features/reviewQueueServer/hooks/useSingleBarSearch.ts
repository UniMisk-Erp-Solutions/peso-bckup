/**
 * One visible search bar, two separate server searches (DOC-080 §8).
 *
 * The production page shows a single input, but the proven separation underneath
 * is preserved exactly: employee lookup runs against the employee RPC, which
 * never sees transaction numbers, and expense text runs as `p_general_search`.
 * Collapsing them into one server-side "search everything" is precisely the bug
 * this replaces — it is how searching 6174 returned transaction 06174 owned by
 * employee 6557 and dropped all 24 of employee 6174's expenses.
 *
 * Resolution order on submit:
 *
 *   1. txn: / # prefix  -> expense search, employee lookup skipped entirely
 *   2. exactly one exact employee match -> select that immutable user_id
 *   3. several employee matches -> ask; nothing loads until a human picks
 *   4. no employee match -> fall through to expense search with the same text
 *
 * Typing does none of this. Everything below runs only from submit().
 */

import { useCallback, useRef, useState } from "react";
import { pickAutoSelectableMatch, searchReviewEmployees } from "../api";
import { toSelectedEmployee } from "./useEmployeeSearch";
import type { ReviewEmployeeMatch, ReviewSelectedEmployee } from "../types";

/**
 * What the search resolved to. The page consumes this as ONE deliberate
 * transition instead of reacting to several state changes separately.
 *
 * This exists because `onResolved()` - a bare notification - carried no
 * information to act on. The page could only clear row selection with it, so
 * selecting an employee left a "Level 2 Verified" status filter active and the
 * reviewer saw an empty table for an employee the search had just reported 24
 * expenses for. A resolution carries WHAT was resolved, so the page can reset
 * exactly the content filters that selection supersedes.
 */
export type SearchResolution =
  | { kind: "employee"; employee: ReviewSelectedEmployee }
  | { kind: "expense"; query: string }
  | { kind: "clear" };

export type SingleBarState =
  | "idle"
  | "searching"
  | "employee_selected"
  | "choose_employee"
  | "expense_search"
  | "error";

const TXN_PREFIX = /^\s*(txn:|#)\s*/i;

/** `txn:06174` and `#06174` mean "this is a transaction, skip employee lookup". */
export function parseExplicitExpenseQuery(raw: string): string | null {
  if (!TXN_PREFIX.test(raw)) return null;
  const stripped = raw.replace(TXN_PREFIX, "").trim();
  return stripped.length > 0 ? stripped : null;
}

export function useSingleBarSearch(params: {
  organizationId: string | null;
  /**
   * Called with the resolution whenever the submitted query resolves. The page
   * treats each kind as a single transition of all related query state.
   */
  onResolved?: (resolution: SearchResolution) => void;
}) {
  const { organizationId, onResolved } = params;

  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [state, setState] = useState<SingleBarState>("idle");
  const [matches, setMatches] = useState<ReviewEmployeeMatch[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<ReviewSelectedEmployee | null>(null);
  const [generalSearch, setGeneralSearch] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const employeeRequestCount = useRef(0);
  /**
   * Serialises submits. Enter plus a button click, or a double click, would
   * otherwise issue two identical employee lookups.
   */
  const inFlight = useRef(false);
  /** Only the newest submit may write state. Older responses are discarded. */
  const submitSeq = useRef(0);

  const clearAll = useCallback(() => {
    setDraft("");
    setSubmitted(null);
    setMatches([]);
    setSelectedEmployee(null);
    setGeneralSearch(null);
    setError(null);
    setState("idle");
    onResolved?.({ kind: "clear" });
  }, [onResolved]);

  const applyExpenseSearch = useCallback(
    (text: string) => {
      setSelectedEmployee(null);
      setMatches([]);
      setGeneralSearch(text);
      setState("expense_search");
      onResolved?.({ kind: "expense", query: text });
    },
    [onResolved],
  );

  const chooseEmployee = useCallback(
    (match: ReviewEmployeeMatch) => {
      const employee = toSelectedEmployee(match);
      setSelectedEmployee(employee);
      // Selecting an employee supersedes any text filter — otherwise the row
      // count would silently be an intersection the reviewer never asked for.
      setGeneralSearch(null);
      setMatches([]);
      setState("employee_selected");
      onResolved?.({ kind: "employee", employee });
    },
    [onResolved],
  );

  /** Runs ONLY from a submit handler (Search button / Enter). Never an effect. */
  const submit = useCallback(async () => {
    const raw = draft.trim();
    if (!organizationId) return;
    // A second submit while one is resolving is always a duplicate of intent,
    // never a new question. Dropping it is correct, not merely cheaper.
    if (inFlight.current) return;
    if (!raw) {
      clearAll();
      return;
    }
    setSubmitted(raw);
    setError(null);

    // 1 — explicit transaction shortcut bypasses employee resolution entirely.
    const explicit = parseExplicitExpenseQuery(raw);
    if (explicit) {
      applyExpenseSearch(explicit);
      return;
    }

    const seq = ++submitSeq.current;
    inFlight.current = true;
    setState("searching");
    try {
      employeeRequestCount.current += 1;
      const result = await searchReviewEmployees({ organizationId, query: raw });

      // A response that is no longer the newest must not write anything -
      // otherwise a slow lookup for "617" could replace a later "6174".
      if (seq !== submitSeq.current) return;

      // 2 — a single unambiguous employee: select their immutable user_id.
      const auto = pickAutoSelectableMatch(result);
      if (auto) {
        const employee = toSelectedEmployee(auto);
        setSelectedEmployee(employee);
        setGeneralSearch(null);
        setMatches([]);
        setState("employee_selected");
        onResolved?.({ kind: "employee", employee });
        return;
      }

      // 3 — ambiguous: ask. Nothing loads until a human picks.
      if (result.matches.length > 0) {
        setMatches(result.matches);
        setSelectedEmployee(null);
        setState("choose_employee");
        return;
      }

      // 4 — not an employee, so treat the text as expense search.
      applyExpenseSearch(raw);
    } catch (e) {
      if (seq !== submitSeq.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
      setState("error");
    } finally {
      if (seq === submitSeq.current) inFlight.current = false;
    }
  }, [draft, organizationId, clearAll, applyExpenseSearch, onResolved]);

  /**
   * Restore a previously submitted search without performing one (DOC-080 §12).
   *
   * Everything here is deliberate about what it does NOT do:
   *
   * - No employee RPC. The snapshot carries the immutable `user_id` alongside the
   *   validated display identity, so the reviewer's selection is reproduced exactly.
   *   Re-searching their display name could resolve to a different person, to several
   *   people, or to nothing — the same class of collision that made searching "6174"
   *   return transaction 06174 owned by employee 6557.
   * - No `onResolved`. That callback means "the reviewer asked a NEW question", and it
   *   resets content filters. Firing it during restoration would wipe the very filters
   *   being restored, in the same commit.
   * - No `employeeRequestCount` increment. That counter exists so tests can assert typing
   *   and restoring issue zero lookups; inflating it here would hide a regression.
   *
   * One call, one commit: draft, submitted, employee, general search and state all move
   * together, so no render ever sees a half-restored search.
   */
  const restoreSearch = useCallback(
    (restored: {
      draft: string;
      submitted: string | null;
      selectedEmployee: ReviewSelectedEmployee | null;
      generalSearch: string | null;
    }) => {
      // An employee filter and a free-text search are alternatives; the validator already
      // rejects a snapshot carrying both, and employee wins here as a second line.
      const employee = restored.selectedEmployee;
      const general = employee ? null : restored.generalSearch;

      setDraft(restored.draft);
      setSubmitted(restored.submitted);
      setSelectedEmployee(employee);
      setGeneralSearch(general);
      setMatches([]);
      setError(null);
      setState(employee ? "employee_selected" : general ? "expense_search" : "idle");
    },
    [],
  );

  /** "Search expenses for …" from the disambiguation popover. */
  const searchExpensesInstead = useCallback(() => {
    const text = (submitted ?? draft).trim();
    if (!text) return;
    applyExpenseSearch(parseExplicitExpenseQuery(text) ?? text);
  }, [submitted, draft, applyExpenseSearch]);

  const clearEmployee = useCallback(() => {
    setSelectedEmployee(null);
    setState(generalSearch ? "expense_search" : "idle");
    onResolved?.(generalSearch ? { kind: "expense", query: generalSearch } : { kind: "clear" });
  }, [generalSearch, onResolved]);

  const clearGeneralSearch = useCallback(() => {
    setGeneralSearch(null);
    setState(selectedEmployee ? "employee_selected" : "idle");
    onResolved?.(
      selectedEmployee ? { kind: "employee", employee: selectedEmployee } : { kind: "clear" },
    );
  }, [selectedEmployee, onResolved]);

  return {
    draft,
    setDraft,
    submitted,
    state,
    matches,
    selectedEmployee,
    generalSearch,
    error,
    submit,
    chooseEmployee,
    searchExpensesInstead,
    clearEmployee,
    clearGeneralSearch,
    clearAll,
    restoreSearch,
    /** True while an employee lookup is resolving, so Search can disable. */
    isResolving: state === "searching",
    getEmployeeRequestCount: () => employeeRequestCount.current,
  };
}
