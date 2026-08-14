/**
 * Browser-local cache for in-progress expense forms.
 * Data stays in localStorage + sessionStorage until the expense is successfully submitted.
 */

const DRAFT_VERSION = 2;
/** Pending drafts are kept until submit (or this safety cap). */
const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ExpenseFormDraftTempMeta = {
  path: string;
  filename: string;
  file_size: number;
  content_type: string;
};

export type ExpenseFormDraft = {
  v: number;
  savedAt: string;
  /** True while the user has not successfully submitted — cleared only on submit. */
  pendingSubmit: boolean;
  expense: {
    title: string;
    destination: string;
    expense_date: string;
    purpose: string;
    amount: number;
    category: string;
  };
  formFieldValues: Record<string, string>;
  branchValues: Record<string, string>;
  attachments: string[];
  sessionTempFilenames: string[];
  sessionTempMeta: ExpenseFormDraftTempMeta[];
};

/** "new" for create flow, or expense UUID when editing in progress. */
export type ExpenseFormDraftScope = "new" | string;

export type ExpenseFormDraftPayload = Omit<ExpenseFormDraft, "v" | "savedAt" | "pendingSubmit">;

export type ExpenseFormDraftSaveResult =
  | { ok: true; savedAt: string }
  | { ok: false; reason: "missing_identity" | "not_meaningful" | "storage_blocked" };

/** In-memory layer for same-tab remounts (camera / gallery). */
const memoryDraftByKey = new Map<string, ExpenseFormDraft>();

export function draftStorageKey(
  userId: string,
  organizationId: string,
  scope: ExpenseFormDraftScope,
): string {
  return `pesowise:expense-browser-cache:${organizationId}:${userId}:${scope}`;
}

function draftBackupKey(userId: string, organizationId: string, scope: ExpenseFormDraftScope) {
  return `${draftStorageKey(userId, organizationId, scope)}:backup`;
}

function pendingIndexKey(userId: string, organizationId: string) {
  return `pesowise:expense-pending-index:${organizationId}:${userId}`;
}

function readFromStore(store: Storage, key: string): ExpenseFormDraft | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExpenseFormDraft;
    if (parsed.v !== DRAFT_VERSION && parsed.v !== 1) return null;
    const age = Date.now() - new Date(parsed.savedAt).getTime();
    const maxAge = parsed.pendingSubmit !== false ? PENDING_MAX_AGE_MS : PENDING_MAX_AGE_MS;
    if (!Number.isFinite(age) || age > maxAge) {
      store.removeItem(key);
      return null;
    }
    return { ...parsed, pendingSubmit: parsed.pendingSubmit !== false };
  } catch {
    return null;
  }
}

function writeToStore(store: Storage, key: string, payload: ExpenseFormDraft): boolean {
  try {
    store.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function touchPendingIndex(
  userId: string,
  organizationId: string,
  scope: ExpenseFormDraftScope,
  savedAt: string,
) {
  if (typeof localStorage === "undefined") return;
  try {
    const key = pendingIndexKey(userId, organizationId);
    const raw = localStorage.getItem(key);
    const index: Record<string, string> = raw ? JSON.parse(raw) : {};
    index[scope] = savedAt;
    localStorage.setItem(key, JSON.stringify(index));
  } catch {
    // ignore
  }
}

function removePendingIndexEntry(
  userId: string,
  organizationId: string,
  scope: ExpenseFormDraftScope,
) {
  if (typeof localStorage === "undefined") return;
  try {
    const key = pendingIndexKey(userId, organizationId);
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const index: Record<string, string> = JSON.parse(raw);
    delete index[scope];
    if (Object.keys(index).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(index));
    }
  } catch {
    // ignore
  }
}

/** True when the user has entered something worth restoring. */
export function isExpenseFormDraftMeaningful(
  draft: Pick<
    ExpenseFormDraftPayload,
    "expense" | "formFieldValues" | "branchValues" | "attachments" | "sessionTempFilenames"
  >,
): boolean {
  const e = draft.expense;
  if (e.title.trim() || e.destination.trim() || (e.purpose || "").trim()) return true;
  if (Number(e.amount) > 0) return true;
  if (draft.attachments.length > 0) return true;
  if ((draft.sessionTempFilenames?.length ?? 0) > 0) return true;
  if (e.category && e.category !== "other") return true;

  const hasFieldValue = Object.values(draft.formFieldValues || {}).some(
    (v) => v && v !== "false" && String(v).trim() !== "",
  );
  if (hasFieldValue) return true;

  const hasBranchValue = Object.values(draft.branchValues || {}).some(
    (v) => v && String(v).trim() !== "",
  );
  return hasBranchValue;
}

/** Load cached form from browser (memory → localStorage → backup → sessionStorage). */
export function loadExpenseFormDraft(
  userId: string | undefined,
  organizationId: string | null | undefined,
  scope: ExpenseFormDraftScope = "new",
): ExpenseFormDraft | null {
  if (!userId || !organizationId) return null;
  const key = draftStorageKey(userId, organizationId, scope);
  const backup = draftBackupKey(userId, organizationId, scope);

  const fromMemory = memoryDraftByKey.get(key);
  if (fromMemory?.pendingSubmit !== false) return fromMemory;

  if (typeof localStorage !== "undefined") {
    const fromLocal = readFromStore(localStorage, key) ?? readFromStore(localStorage, backup);
    if (fromLocal) {
      memoryDraftByKey.set(key, fromLocal);
      return fromLocal;
    }
  }
  if (typeof sessionStorage !== "undefined") {
    const fromSession =
      readFromStore(sessionStorage, key) ?? readFromStore(sessionStorage, backup);
    if (fromSession) {
      memoryDraftByKey.set(key, fromSession);
      return fromSession;
    }
  }
  return null;
}

/** Whether this user/org has a pending (unsubmitted) cached form for the scope. */
export function hasPendingExpenseFormDraft(
  userId: string | undefined,
  organizationId: string | null | undefined,
  scope: ExpenseFormDraftScope = "new",
): boolean {
  const draft = loadExpenseFormDraft(userId, organizationId, scope);
  return Boolean(draft && isExpenseFormDraftMeaningful(draft));
}

/**
 * Save to browser cache. Stays until {@link clearExpenseFormDraft} runs after successful submit.
 */
export function saveExpenseFormDraft(
  userId: string | undefined,
  organizationId: string | null | undefined,
  draft: ExpenseFormDraftPayload,
  scope: ExpenseFormDraftScope = "new",
  options?: { force?: boolean },
): ExpenseFormDraftSaveResult {
  if (!userId || !organizationId) {
    return { ok: false, reason: "missing_identity" };
  }

  const meaningful = isExpenseFormDraftMeaningful(draft);
  const key = draftStorageKey(userId, organizationId, scope);
  const backup = draftBackupKey(userId, organizationId, scope);
  const existing = loadExpenseFormDraft(userId, organizationId, scope);

  if (!meaningful && !options?.force) {
    if (existing && isExpenseFormDraftMeaningful(existing)) {
      return { ok: true, savedAt: existing.savedAt };
    }
    return { ok: false, reason: "not_meaningful" };
  }

  if (!meaningful && existing && isExpenseFormDraftMeaningful(existing) && !options?.force) {
    return { ok: true, savedAt: existing.savedAt };
  }

  const payload: ExpenseFormDraft = {
    v: DRAFT_VERSION,
    savedAt: new Date().toISOString(),
    pendingSubmit: true,
    ...draft,
  };

  memoryDraftByKey.set(key, payload);

  let diskSaved = false;
  if (typeof localStorage !== "undefined") {
    const mainOk = writeToStore(localStorage, key, payload);
    const backupOk = writeToStore(localStorage, backup, payload);
    diskSaved = mainOk || backupOk;
    if (diskSaved) touchPendingIndex(userId, organizationId, scope, payload.savedAt);
  }
  if (typeof sessionStorage !== "undefined") {
    const mainOk = writeToStore(sessionStorage, key, payload);
    const backupOk = writeToStore(sessionStorage, backup, payload);
    diskSaved = diskSaved || mainOk || backupOk;
  }

  if (!diskSaved && meaningful) {
    return { ok: true, savedAt: payload.savedAt };
  }

  if (!diskSaved && !memoryDraftByKey.has(key)) {
    return { ok: false, reason: "storage_blocked" };
  }

  return { ok: true, savedAt: payload.savedAt };
}

/** Remove browser cache — call only after expense is successfully submitted. */
export function clearExpenseFormDraft(
  userId: string | undefined,
  organizationId: string | null | undefined,
  scope: ExpenseFormDraftScope = "new",
): void {
  if (!userId || !organizationId) return;
  const key = draftStorageKey(userId, organizationId, scope);
  const backup = draftBackupKey(userId, organizationId, scope);
  memoryDraftByKey.delete(key);
  removePendingIndexEntry(userId, organizationId, scope);
  try {
    localStorage?.removeItem(key);
    localStorage?.removeItem(backup);
    sessionStorage?.removeItem(key);
    sessionStorage?.removeItem(backup);
  } catch {
    // ignore
  }
}

/** Alias: cache cleared because the form was submitted successfully. */
export function markExpenseFormDraftSubmitted(
  userId: string | undefined,
  organizationId: string | null | undefined,
  scope: ExpenseFormDraftScope = "new",
): void {
  clearExpenseFormDraft(userId, organizationId, scope);
}
