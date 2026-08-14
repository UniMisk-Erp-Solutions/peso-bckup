/**
 * Manual, submit-driven employee search (DOC-080).
 *
 * THE core requirement: typing must not query. `draft` changes on every
 * keystroke; nothing observes it. The RPC runs only from `submit()`, which a
 * click or Enter calls. There is deliberately no useEffect watching `draft` and
 * no debounce — a debounce would still fire on typing, which is exactly what is
 * forbidden.
 */

import { useCallback, useRef, useState } from "react";
import { pickAutoSelectableMatch, searchReviewEmployees } from "../api";
import type { ReviewEmployeeMatch, ReviewSelectedEmployee } from "../types";

export type EmployeeSearchState =
  | "idle"
  | "searching"
  | "selected"
  | "needs_selection"
  | "not_found"
  | "error";

export function toSelectedEmployee(m: ReviewEmployeeMatch): ReviewSelectedEmployee {
  return {
    user_id: m.user_id,
    employee_name: m.employee_name,
    employee_id: m.employee_id,
    identity_source: m.identity_source,
    identity_issue: m.identity_issue ?? null,
    visible_expense_count: m.visible_expense_count,
    actionable_expense_count: m.actionable_expense_count,
  };
}

export function useEmployeeSearch(organizationId: string | null) {
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [state, setState] = useState<EmployeeSearchState>("idle");
  const [matches, setMatches] = useState<ReviewEmployeeMatch[]>([]);
  const [selected, setSelected] = useState<ReviewSelectedEmployee | null>(null);
  const [error, setError] = useState<Error | null>(null);
  /** Counts RPC calls — asserted by tests to prove typing issues none. */
  const requestCount = useRef(0);

  const clear = useCallback(() => {
    setDraft("");
    setSubmitted(null);
    setMatches([]);
    setSelected(null);
    setError(null);
    setState("idle");
  }, []);

  /** Runs ONLY from a submit handler. Never from an effect. */
  const submit = useCallback(async () => {
    const query = draft.trim();
    if (!organizationId) return;
    if (!query) {
      clear();
      return;
    }
    setSubmitted(query);
    setState("searching");
    setError(null);
    try {
      requestCount.current += 1;
      const result = await searchReviewEmployees({ organizationId, query });
      setMatches(result.matches);
      if (result.matches.length === 0) {
        setSelected(null);
        setState("not_found");
        return;
      }
      const auto = pickAutoSelectableMatch(result);
      if (auto) {
        setSelected(toSelectedEmployee(auto));
        setState("selected");
        return;
      }
      // Ambiguous — a human must choose. Never merge candidates automatically.
      setSelected(null);
      setState("needs_selection");
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setState("error");
    }
  }, [draft, organizationId, clear]);

  const select = useCallback((match: ReviewEmployeeMatch) => {
    setSelected(toSelectedEmployee(match));
    setMatches([]);
    setState("selected");
  }, []);

  return {
    draft,
    setDraft,
    submitted,
    state,
    matches,
    selected,
    error,
    submit,
    select,
    clear,
    getRequestCount: () => requestCount.current,
  };
}
