import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clearExpenseFormDraft,
  isExpenseFormDraftMeaningful,
  loadExpenseFormDraft,
  saveExpenseFormDraft,
  type ExpenseFormDraft,
  type ExpenseFormDraftPayload,
  type ExpenseFormDraftScope,
} from "@/lib/expenseFormDraft";

export type ExpenseFormDraftNotice = "none" | "saved" | "restored" | "save_failed";

type UseExpenseFormDraftOptions = {
  userId: string | undefined;
  organizationId: string | null | undefined;
  scope: ExpenseFormDraftScope;
  /** True when editing an existing expense (`/expenses/:id/edit`). */
  isEditRoute: boolean;
  getPayload: () => ExpenseFormDraftPayload;
  applyDraft: (draft: ExpenseFormDraft) => void;
  /** When any of these change, draft is written to storage (pass form state). */
  autosaveDeps?: unknown[];
};

export function useExpenseFormDraft({
  userId,
  organizationId,
  scope,
  isEditRoute,
  getPayload,
  applyDraft,
  autosaveDeps = [],
}: UseExpenseFormDraftOptions) {
  const [editFormReady, setEditFormReady] = useState(false);
  const [draftHydrated, setDraftHydrated] = useState(isEditRoute);
  const [draftNotice, setDraftNotice] = useState<ExpenseFormDraftNotice>("none");
  const draftRestoreDoneRef = useRef(false);
  /** When true, skip autosave/unmount persist (after successful submit). */
  const autosaveSuppressedRef = useRef(false);
  const bootContextRef = useRef({ scope, isEditRoute });
  const getPayloadRef = useRef(getPayload);
  const applyDraftRef = useRef(applyDraft);

  getPayloadRef.current = getPayload;
  applyDraftRef.current = applyDraft;

  /** New expense: never gate the UI on draft bootstrap (auth refresh must not leave the form stuck). */
  const formReady = isEditRoute ? editFormReady : Boolean(userId);

  const persistDraft = useCallback(
    (options?: { force?: boolean; silent?: boolean }) => {
      if (autosaveSuppressedRef.current) return;
      if (!userId || !organizationId) return;
      const result = saveExpenseFormDraft(
        userId,
        organizationId,
        getPayloadRef.current(),
        scope,
        { force: options?.force },
      );
      if (result.ok) {
        if (!options?.silent) setDraftNotice("saved");
      } else if (result.reason === "storage_blocked") {
        setDraftNotice("save_failed");
      }
      return result;
    },
    [userId, organizationId, scope],
  );

  const restoreDraftIfAny = useCallback(
    (options?: { showNotice?: boolean }) => {
      if (!userId || !organizationId) return false;
      const draft = loadExpenseFormDraft(userId, organizationId, scope);
      if (!draft || !isExpenseFormDraftMeaningful(draft)) return false;
      try {
        applyDraftRef.current(draft);
      } catch (err) {
        console.warn("expense form draft restore failed:", err);
        return false;
      }
      if (options?.showNotice !== false) {
        setDraftNotice("restored");
      }
      return true;
    },
    [userId, organizationId, scope],
  );

  const clearDraft = useCallback(() => {
    if (!userId || !organizationId) return;
    clearExpenseFormDraft(userId, organizationId, scope);
    setDraftNotice("none");
  }, [userId, organizationId, scope]);

  /** After successful submit — clear storage and block re-save on unmount/autosave. */
  const finalizeAfterSubmit = useCallback(() => {
    if (!userId || !organizationId) return;
    autosaveSuppressedRef.current = true;
    clearExpenseFormDraft(userId, organizationId, scope);
    setDraftNotice("none");
  }, [userId, organizationId, scope]);

  /** Manual reset — clear storage without suppressing future autosave. */
  const clearDraftForManualReset = useCallback(() => {
    if (!userId || !organizationId) return;
    clearExpenseFormDraft(userId, organizationId, scope);
    setDraftNotice("none");
    draftRestoreDoneRef.current = true;
  }, [userId, organizationId, scope]);

  const completeEditBootstrap = useCallback(() => {
    setEditFormReady(true);
  }, []);

  useLayoutEffect(() => {
    const prev = bootContextRef.current;
    if (prev.scope !== scope || prev.isEditRoute !== isEditRoute) {
      bootContextRef.current = { scope, isEditRoute };
      draftRestoreDoneRef.current = false;
      setDraftNotice("none");
      setDraftHydrated(isEditRoute);
      if (isEditRoute) {
        setEditFormReady(false);
      }
    }

    if (isEditRoute) {
      if (!userId || !organizationId) {
        setEditFormReady(false);
      }
      return;
    }

    if (!userId) {
      draftRestoreDoneRef.current = false;
      setDraftHydrated(false);
      return;
    }

    if (!organizationId) return;

    if (!draftRestoreDoneRef.current) {
      draftRestoreDoneRef.current = true;
      restoreDraftIfAny({ showNotice: true });
    }
    setDraftHydrated(true);
  }, [userId, organizationId, isEditRoute, scope, restoreDraftIfAny]);

  useEffect(() => {
    if (isEditRoute || !formReady || !userId || !organizationId) return;
    restoreDraftIfAny({ showNotice: false });
  }, [isEditRoute, formReady, userId, organizationId, restoreDraftIfAny]);

  const persistRef = useRef(persistDraft);
  persistRef.current = persistDraft;
  const restoreRef = useRef(restoreDraftIfAny);
  restoreRef.current = restoreDraftIfAny;

  const canAutosave = formReady && draftHydrated && Boolean(userId && organizationId);

  useEffect(() => {
    if (!canAutosave) return;
    const payload = getPayloadRef.current();
    const meaningful = isExpenseFormDraftMeaningful(payload);
    persistRef.current({ silent: !meaningful, force: meaningful });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- autosaveDeps supplied by caller
  }, [canAutosave, userId, organizationId, ...autosaveDeps]);

  useEffect(() => {
    return () => {
      if (autosaveSuppressedRef.current) return;
      if (userId && organizationId) {
        persistRef.current({ force: true, silent: true });
      }
    };
  }, [userId, organizationId]);

  useEffect(() => {
    if (!canAutosave) return;
    const interval = window.setInterval(() => {
      if (autosaveSuppressedRef.current) return;
      const payload = getPayloadRef.current();
      if (isExpenseFormDraftMeaningful(payload)) {
        persistRef.current({ force: true, silent: true });
      }
    }, 2000);
    return () => window.clearInterval(interval);
  }, [canAutosave, userId, organizationId, scope]);

  useEffect(() => {
    if (!userId || !organizationId) return;

    const onHide = () => {
      if (autosaveSuppressedRef.current) return;
      persistRef.current({ force: true, silent: true });
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        onHide();
        return;
      }
      // Do NOT restore on visible when the tab is alive: React state is still in memory and
      // needs no restoration. Restoring here would invoke applyDraft (with its captured
      // fetchCategoryFormFields closure) unnecessarily and could overwrite in-memory state.
      // Page-reload restores are handled by pageshow + useLayoutEffect, both of which wait
      // until userId AND organizationId are loaded before calling restoreDraftIfAny, so
      // fetchCategoryFormFields always runs with a fresh, correct closure.
      if (document.visibilityState === "visible" && formReady && !autosaveSuppressedRef.current) {
        persistRef.current({ force: true, silent: true });
      }
    };

    const onPageShow = (event: PageTransitionEvent) => {
      // bfcache restore (Edge/Chrome back-forward): React state is intact, skip restore
      if (event.persisted) return;
      if (!formReady || autosaveSuppressedRef.current) return;
      restoreRef.current({ showNotice: true });
    };

    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [userId, organizationId, formReady]);

  return {
    formReady,
    draftNotice,
    setDraftNotice,
    persistDraft,
    restoreDraftIfAny,
    clearDraft,
    finalizeAfterSubmit,
    clearDraftForManualReset,
    completeEditBootstrap,
  };
}
