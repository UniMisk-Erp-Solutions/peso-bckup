import { supabase } from "@/integrations/supabase/client";
import type { BaseExpenseFieldKey, BaseFieldInputType } from "@/lib/expenseFormConfig";

// New RPCs (DOC-130) aren't in the generated Database types until the
// migration is applied and types are regenerated -- same escape hatch used
// by src/lib/expenseRecycleBin.ts for its own new RPCs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ---------------------------------------------------------------------------
// Recently-used FREE-TEXT expense field values (DOC-130).
//
// This is deliberately separate from src/lib/recommendedFormFieldOptions.ts
// (DOC-003), which re-ranks an EXISTING static option list for select-type
// fields. This module covers the gap DOC-003 does not: fields with no fixed
// option list -- base title/destination/purpose (when not overridden to
// "dropdown"/"number") and custom text/textarea template + branch fields.
// Select-type fields are intentionally out of scope here; use DOC-003 for
// those.
// ---------------------------------------------------------------------------

export type MemoryFieldKind = "system" | "custom" | "branch";

/** Only these base field keys are ever free-text-memory eligible (category
 *  is a managed dropdown, expense_date is a date, amount is currency -- a
 *  closed platform-wide enum, not an organization-specific choice). */
const ELIGIBLE_BASE_FIELD_KEYS: ReadonlySet<BaseExpenseFieldKey> = new Set([
  "title",
  "destination",
  "purpose",
]);

/** Custom/branch field types eligible for free-text memory. "select" is
 *  DOC-003's turf; "number"/"date"/"checkbox" have no meaningful "recent
 *  value" semantics (e.g. an odometer reading only ever increases). */
const ELIGIBLE_CUSTOM_FIELD_TYPES: ReadonlySet<string> = new Set(["text", "textarea"]);

export function memoryFieldKey(kind: MemoryFieldKind, id: string): string {
  return `${kind}:${id}`;
}

/** Whether a base field (given its resolved org config) is eligible for free-text memory. */
export function isEligibleBaseFieldForMemory(
  fieldKey: BaseExpenseFieldKey,
  inputType: BaseFieldInputType,
): boolean {
  return ELIGIBLE_BASE_FIELD_KEYS.has(fieldKey) && (inputType === "default" || inputType === "text");
}

/** Whether a custom template/branch field type is eligible for free-text memory. */
export function isEligibleCustomFieldType(fieldType: string): boolean {
  return ELIGIBLE_CUSTOM_FIELD_TYPES.has(fieldType);
}

/** Mirrors the server-side normalization exactly (trim, collapse whitespace, casefold). */
export function normalizeFieldValue(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------
// Shared per-(org,user) fetch: one DB call, coalesced + cached, same pattern
// as recommendedFormFieldOptions.ts's _fetchAllUsageRows.
// ---------------------------------------------------------------------------

type RecentRow = {
  field_identity: string;
  display_value: string;
  normalized_value: string;
  last_used_at: string;
  usage_count: number;
};

const _inflight = new Map<string, Promise<RecentRow[]>>();
const _cache = new Map<string, { data: RecentRow[]; ts: number }>();
const CACHE_TTL_MS = 60_000;

function _cacheKey(organizationId: string, userId: string): string {
  return `${organizationId}:${userId}`;
}

async function _fetchAllRecentRows(organizationId: string, userId: string): Promise<RecentRow[]> {
  const key = _cacheKey(organizationId, userId);

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const existing = _inflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<RecentRow[]> => {
    try {
      // Best-effort, once per (org, user) per tab session -- see _ensureBootstrapped.
      // A failure here must never block the read: an employee whose bootstrap
      // errored simply sees an empty list, same as "no history yet".
      await _ensureBootstrapped(organizationId, userId);
      const { data, error } = await db.rpc("get_recent_expense_field_values_v1", {
        p_organization_id: organizationId,
        p_field_identities: null,
      });
      _inflight.delete(key);
      if (error || !data) {
        if (error) console.warn("get_recent_expense_field_values_v1:", error.message);
        return [];
      }
      const rows = data as RecentRow[];
      _cache.set(key, { data: rows, ts: Date.now() });
      return rows;
    } catch (e) {
      _inflight.delete(key);
      console.warn("get_recent_expense_field_values_v1:", e);
      return [];
    }
  })();

  _inflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Self bootstrap: the FIRST time a given (org, user) reads recent values in
// this tab session, ask the server to seed this employee's own memory from
// their own approved historical expenses -- exactly once, ever, per
// employee (bootstrap_my_expense_field_memory_v1 is itself idempotent
// server-side via expense_field_memory_user_state, so this in-memory map is
// just an optimization to avoid firing the RPC redundantly from every
// mounted field in the same page load, not the source of correctness).
// ---------------------------------------------------------------------------
const _bootstrapAttempted = new Map<string, Promise<void>>();

async function _ensureBootstrapped(organizationId: string, userId: string): Promise<void> {
  const key = _cacheKey(organizationId, userId);
  const existing = _bootstrapAttempted.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<void> => {
    try {
      const { error } = await db.rpc("bootstrap_my_expense_field_memory_v1", {
        p_organization_id: organizationId,
      });
      if (error) console.warn("bootstrap_my_expense_field_memory_v1:", error.message);
    } catch (e) {
      console.warn("bootstrap_my_expense_field_memory_v1:", e);
    }
  })();

  _bootstrapAttempted.set(key, promise);
  return promise;
}

// Bumped every time this (org, user)'s cache is invalidated. useRecentExpenseFieldValues
// reads this into its effect's dependency array so a save that does NOT unmount the form
// (e.g. the same route/component instance handles the next expense) still refetches on
// the next render, rather than only working via a full remount's fresh effect run.
const _version = new Map<string, number>();

export function getRecentValuesVersion(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
): number {
  if (!organizationId || !userId) return 0;
  return _version.get(_cacheKey(organizationId, userId)) ?? 0;
}

function _invalidateCache(organizationId: string, userId: string): void {
  const key = _cacheKey(organizationId, userId);
  _cache.delete(key);
  _version.set(key, (_version.get(key) ?? 0) + 1);
}

/**
 * Batch fetch recent values for a set of field identities. Degrades to an
 * empty map for any identity on any error, missing org/user, or disabled
 * feature -- callers never need to distinguish "off" from "no data yet".
 */
export async function fetchRecentExpenseFieldValues(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
  identities: string[],
): Promise<Record<string, string[]>> {
  const result: Record<string, string[]> = {};
  if (!organizationId || !userId || identities.length === 0) return result;

  const rows = await _fetchAllRecentRows(organizationId, userId);
  const wanted = new Set(identities);

  for (const row of rows) {
    if (!wanted.has(row.field_identity)) continue;
    if (!result[row.field_identity]) result[row.field_identity] = [];
    result[row.field_identity].push(row.display_value);
  }
  return result;
}

/**
 * Best-effort: derive + upsert recent values from the ALREADY-PERSISTED
 * expense row server-side. Call this strictly AFTER the expense (and its
 * custom field values) have successfully saved -- never inside the same
 * transaction/await-chain that could still fail the save itself. Never
 * throws; failures are logged and swallowed so a memory hiccup can never be
 * mistaken for (or cause) a failed expense save.
 */
export async function recordRecentExpenseFieldValues(
  organizationId: string | null | undefined,
  userId: string | null | undefined,
  expenseId: string,
): Promise<void> {
  try {
    const { error } = await db.rpc("record_recent_expense_field_values_v1", {
      p_expense_id: expenseId,
    });
    if (error) {
      console.warn("recordRecentExpenseFieldValues:", error.message);
      return;
    }
    if (organizationId && userId) _invalidateCache(organizationId, userId);
  } catch (e) {
    console.warn("recordRecentExpenseFieldValues:", e);
  }
}
