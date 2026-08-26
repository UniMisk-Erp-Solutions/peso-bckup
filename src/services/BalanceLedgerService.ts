import { supabase } from "@/integrations/supabase/client";

// DOC-103. Canonical server-side balance mutation + ledger read service.
// Every call here goes through a SECURITY DEFINER RPC that locks the
// affected profile row(s), computes the mutation in SQL, and writes an
// immutable balance_ledger entry inside the same transaction. The browser
// never computes or sends a before/after balance as authority.
//
// These RPCs are not yet in the generated Database types (types.ts is
// regenerated from the schema separately), so calls are cast through
// `supabase.rpc as any` -- the same pattern already used elsewhere in this
// codebase for tables/RPCs ahead of a types regeneration (e.g.
// cash_transfer_history in Balances.tsx).
const rpc = supabase.rpc.bind(supabase) as unknown as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

export type PaymentMode = "cash" | "bank_transfer";
export type ImportMode = "historical_opening" | "balance_update" | "allocation";
export type ImportRowValidationStatus =
  | "valid"
  | "unknown"
  | "ambiguous"
  | "invalid_amount"
  | "invalid_date"
  | "duplicate"
  | "no_op";

// Historical Balance Anchors V2. historical_opening/balance_update are
// HISTORICAL BALANCE ANCHORS, not direct balance writes: the server
// reconstructs the employee's balance immediately before the anchor's
// timeline position and applies only the MISSING historical effect
// (stated_balance - reconstructed_position), never "set balance = stated
// value". See supabase/migrations/20260824110000_historical_balance_anchors_engine.sql
// for the full engine and Documentations MD's 2026-08-24 revision-log entry
// for the accounting design this implements.
export type AnchorKind = "opening_balance" | "balance_update";
export type AnchorAction = "create" | "supersede";
export type AnchorStatus = "active" | "superseded" | "reversed";

export interface AnchorConflict {
  conflict_type: "opening_balance_exists" | "same_day_anchor_exists";
  existing_anchor_id?: string;
  existing_effective_date?: string;
  existing_stated_balance?: number;
  existing_note?: string | null;
  existing_created_by?: string;
  existing_created_at?: string;
  existing_anchors?: Array<{
    existing_anchor_id: string;
    anchor_kind?: AnchorKind;
    stated_balance: number;
    note: string | null;
    created_by: string;
    created_at: string;
    sequence_number: number;
  }>;
}

export interface DownstreamAnchorEffect {
  anchor_id: string;
  old_delta: number;
  new_delta: number;
  net_change: number;
}

export interface HistoricalAnchorPreviewResult {
  ok: true;
  blocked?: boolean;
  conflicts?: AnchorConflict[];
  anchor_id?: string;
  revision_group_id?: string;
  revision_number?: number;
  materialized_delta?: number;
  current_balance_before?: number;
  current_balance_after?: number;
  downstream_anchors_recalculated?: DownstreamAnchorEffect[];
  preview_only: true;
}

export interface HistoricalAnchorApplyResult {
  ok: true;
  anchor_id: string;
  revision_group_id: string;
  revision_number: number;
  materialized_delta: number;
  current_balance_before: number;
  current_balance_after: number;
  downstream_anchors_recalculated: DownstreamAnchorEffect[];
}

export interface HistoricalAnchorReverseResult {
  ok: true;
  anchor_id: string;
  reversal_net_change: number;
  downstream_anchors_recalculated: DownstreamAnchorEffect[];
}

export interface HistoricalAnchor {
  id: string;
  anchor_kind: AnchorKind;
  effective_date: string;
  day_position: 0 | 2;
  sequence_number: number;
  stated_balance: number;
  materialized_delta: number | null;
  status: AnchorStatus;
  revision_group_id: string;
  revision_number: number;
  supersedes_anchor_id: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
  note: string | null;
  reason: string | null;
  created_by: string;
  created_at: string;
  created_by_name: string | null;
}

export interface AddFundsResult {
  ok: true;
  already_applied?: boolean;
  target_user_id: string;
  target_name?: string;
  amount?: number;
  payment_mode?: PaymentMode;
  actor_balance_after?: number;
  target_balance_after?: number;
  ledger_entry_id: string;
}

export interface AdjustBalanceResult {
  ok: true;
  no_op?: boolean;
  target_user_id?: string;
  balance?: number;
  balance_before?: number;
  balance_after?: number;
  delta?: number;
  ledger_entry_id?: string;
}

export interface ImportValidateResult {
  ok: true;
  batch_id: string;
  row_count: number;
  valid_row_count: number;
  invalid_row_count: number;
  total_delta: number;
  apply_disabled: boolean;
}

export interface ImportApplyRowResult {
  row_number: number;
  employee_id: string | null;
  employee_name: string | null;
  before: number;
  input_amount: number;
  after: number;
  no_op: boolean;
  ledger_entry_id: string | null;
}

export interface ImportApplyResult {
  ok: true;
  already_applied?: boolean;
  batch_id: string;
  mode?: ImportMode;
  row_count: number;
  changed_count: number;
  no_op_count?: number;
  total_delta: number;
  rows?: ImportApplyRowResult[];
}

export interface ImportReverseResult {
  ok: true;
  batch_id: string;
  reversed_count: number;
  blocked: Array<{ employee_id: string; employee_name: string; reason: string }>;
}

export interface LedgerEntry {
  id: string;
  entry_type: string;
  amount_delta: number;
  balance_after: number;
  effective_at: string;
  note: string | null;
  source_type: string;
  actor_name: string | null;
  total_count: number;
}

export interface OrgLedgerEntry extends LedgerEntry {
  user_id: string;
  employee_id: string | null;
  employee_name: string | null;
  balance_before: number;
  source_id: string | null;
}

function unwrap<T>(data: unknown, error: { message: string } | null): T {
  if (error) {
    throw new Error(error.message);
  }
  return data as T;
}

/**
 * Canonical Admin Add / Cashier Cash Transfer RPC. `payment_mode: "cash"`
 * debits the caller (cashier or admin) and credits the target atomically.
 * `payment_mode: "bank_transfer"` only credits the target -- the caller's
 * own balance is never touched in that mode.
 */
export async function addFunds(params: {
  targetUserId: string;
  amount: number;
  paymentMode: PaymentMode;
  sourceBankAccountId?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
}): Promise<AddFundsResult> {
  const { data, error } = await rpc("balance_add_funds_v1", {
    p_target_user_id: params.targetUserId,
    p_amount: params.amount,
    p_payment_mode: params.paymentMode,
    p_source_bank_account_id: params.sourceBankAccountId ?? null,
    p_note: params.note ?? null,
    p_idempotency_key: params.idempotencyKey ?? null,
  });
  return unwrap<AddFundsResult>(data, error);
}

/** Canonical admin Set/Adjust Balance RPC. A reason is required server-side. */
export async function adjustBalance(params: {
  targetUserId: string;
  newBalance: number;
  reason: string;
}): Promise<AdjustBalanceResult> {
  const { data, error } = await rpc("balance_adjust_v1", {
    p_target_user_id: params.targetUserId,
    p_new_balance: params.newBalance,
    p_reason: params.reason,
  });
  return unwrap<AdjustBalanceResult>(data, error);
}

/** Read-only dry-run/preview for a staged import batch. Never mutates money. */
export async function validateImportBatch(batchId: string): Promise<ImportValidateResult> {
  const { data, error } = await rpc("balance_validate_import_v1", { p_batch_id: batchId });
  return unwrap<ImportValidateResult>(data, error);
}

/** Atomic, all-or-nothing Apply for a validated import batch. Idempotent. */
export async function applyImportBatch(batchId: string): Promise<ImportApplyResult> {
  const { data, error } = await rpc("balance_apply_import_v1", { p_batch_id: batchId });
  return unwrap<ImportApplyResult>(data, error);
}

/** Compensating-entry reversal of an applied import batch. Admin only. */
export async function reverseImportBatch(
  batchId: string,
  reason: string,
): Promise<ImportReverseResult> {
  const { data, error } = await rpc("balance_reverse_import_v1", {
    p_batch_id: batchId,
    p_reason: reason,
  });
  return unwrap<ImportReverseResult>(data, error);
}

/** The caller's own ledger history (employee-safe, RLS-scoped to auth.uid()). */
export async function getMyBalanceLedger(params: {
  organizationId: string;
  limit?: number;
  offset?: number;
}): Promise<LedgerEntry[]> {
  const { data, error } = await rpc("get_my_balance_ledger_v1", {
    p_organization_id: params.organizationId,
    p_limit: params.limit ?? 25,
    p_offset: params.offset ?? 0,
  });
  return unwrap<LedgerEntry[]>(data, error);
}

export interface UnifiedBalanceHistoryEvent {
  event_id: string;
  event_type: string;
  amount_delta: number;
  balance_after: number;
  effective_at: string;
  source_type: string;
  source_id: string | null;
  note: string | null;
  actor_name: string | null;
  total_count: number;
}

/**
 * The caller's own balance_ledger UNION ALL expense_balance_deductions
 * timeline, correctly globally paginated server-side (own-row-only).
 */
export async function getMyUnifiedBalanceHistory(params: {
  organizationId: string;
  limit?: number;
  offset?: number;
}): Promise<UnifiedBalanceHistoryEvent[]> {
  const { data, error } = await rpc("get_my_unified_balance_history_v1", {
    p_organization_id: params.organizationId,
    p_limit: params.limit ?? 25,
    p_offset: params.offset ?? 0,
  });
  return unwrap<UnifiedBalanceHistoryEvent[]>(data, error);
}

/** Org-wide (optionally per-employee) ledger drill-down. Admin only. */
export async function getOrgBalanceLedger(params: {
  organizationId: string;
  userId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<OrgLedgerEntry[]> {
  const { data, error } = await rpc("get_org_balance_ledger_v1", {
    p_organization_id: params.organizationId,
    p_user_id: params.userId ?? null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
  });
  return unwrap<OrgLedgerEntry[]>(data, error);
}

export interface AnchorHistoryFields {
  anchor_kind: AnchorKind | null;
  anchor_stated_balance: number | null;
  anchor_effective_date: string | null;
  anchor_status: AnchorStatus | null;
}

export type UnifiedBalanceHistoryEventV2 = UnifiedBalanceHistoryEvent & AnchorHistoryFields;
export type OrgLedgerEntryV2 = OrgLedgerEntry & AnchorHistoryFields;

/**
 * Historical Balance Anchors V2. Identical to getMyUnifiedBalanceHistory,
 * with anchor_kind/anchor_stated_balance/anchor_effective_date/anchor_status
 * added (null for every non-anchor event) so the History UI can show a
 * Balance Update's TARGET alongside its ledgered adjustment delta.
 */
export async function getMyUnifiedBalanceHistoryV2(params: {
  organizationId: string;
  limit?: number;
  offset?: number;
}): Promise<UnifiedBalanceHistoryEventV2[]> {
  const { data, error } = await rpc("get_my_unified_balance_history_v2", {
    p_organization_id: params.organizationId,
    p_limit: params.limit ?? 25,
    p_offset: params.offset ?? 0,
  });
  return unwrap<UnifiedBalanceHistoryEventV2[]>(data, error);
}

/** Historical Balance Anchors V2 admin drill-down (see getMyUnifiedBalanceHistoryV2). */
export async function getOrgBalanceLedgerV2(params: {
  organizationId: string;
  userId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<OrgLedgerEntryV2[]> {
  const { data, error } = await rpc("get_org_balance_ledger_v2", {
    p_organization_id: params.organizationId,
    p_user_id: params.userId ?? null,
    p_limit: params.limit ?? 50,
    p_offset: params.offset ?? 0,
  });
  return unwrap<OrgLedgerEntryV2[]>(data, error);
}

/**
 * Read-only. Runs the real create/supersede logic server-side inside a
 * sub-transaction it then rolls back, so the previewed numbers are exactly
 * what balance_apply_import_v2 / applyHistoricalAnchor would produce.
 */
export async function previewHistoricalAnchor(params: {
  organizationId: string;
  targetUserId: string;
  anchorKind: AnchorKind;
  effectiveDate: string;
  statedBalance: number;
  action: AnchorAction;
  targetAnchorId?: string | null;
  note?: string | null;
}): Promise<HistoricalAnchorPreviewResult> {
  const { data, error } = await rpc("balance_preview_historical_anchor_v1", {
    p_organization_id: params.organizationId,
    p_target_user_id: params.targetUserId,
    p_anchor_kind: params.anchorKind,
    p_effective_date: params.effectiveDate,
    p_stated_balance: params.statedBalance,
    p_action: params.action,
    p_target_anchor_id: params.targetAnchorId ?? null,
    p_note: params.note ?? null,
  });
  return unwrap<HistoricalAnchorPreviewResult>(data, error);
}

/** Atomic create/supersede of one historical balance anchor for one employee. Admin only. */
export async function applyHistoricalAnchor(params: {
  organizationId: string;
  targetUserId: string;
  anchorKind: AnchorKind;
  effectiveDate: string;
  statedBalance: number;
  action: AnchorAction;
  note?: string | null;
  targetAnchorId?: string | null;
  reason?: string | null;
}): Promise<HistoricalAnchorApplyResult> {
  const { data, error } = await rpc("balance_apply_historical_anchor_v1", {
    p_organization_id: params.organizationId,
    p_target_user_id: params.targetUserId,
    p_anchor_kind: params.anchorKind,
    p_effective_date: params.effectiveDate,
    p_stated_balance: params.statedBalance,
    p_action: params.action,
    p_note: params.note ?? null,
    p_target_anchor_id: params.targetAnchorId ?? null,
    p_reason: params.reason ?? null,
  });
  return unwrap<HistoricalAnchorApplyResult>(data, error);
}

/** Retire (never delete) an active historical anchor. Admin only. */
export async function reverseHistoricalAnchor(
  anchorId: string,
  reason: string,
): Promise<HistoricalAnchorReverseResult> {
  const { data, error } = await rpc("balance_reverse_historical_anchor_v1", {
    p_anchor_id: anchorId,
    p_reason: reason,
  });
  return unwrap<HistoricalAnchorReverseResult>(data, error);
}

/** An employee's historical anchors, in timeline order. Admin only. */
export async function getBalanceHistoricalAnchors(params: {
  organizationId: string;
  userId: string;
  includeSuperseded?: boolean;
}): Promise<HistoricalAnchor[]> {
  const { data, error } = await rpc("get_balance_historical_anchors_v1", {
    p_organization_id: params.organizationId,
    p_user_id: params.userId,
    p_include_superseded: params.includeSuperseded ?? false,
  });
  const result = unwrap<{ ok: true; anchors: HistoricalAnchor[] }>(data, error);
  return result.anchors;
}

export interface ImportValidateResultV2 extends ImportValidateResult {
  conflict_count: number;
}

/** Historical Balance Anchors V2 validate/dry-run. See balance_validate_import_v2. */
export async function validateImportBatchV2(batchId: string): Promise<ImportValidateResultV2> {
  const { data, error } = await rpc("balance_validate_import_v2", { p_batch_id: batchId });
  return unwrap<ImportValidateResultV2>(data, error);
}

export interface RowResolution {
  action: "create" | "replace" | "edit" | "skip";
  target_anchor_id?: string;
  reason?: string;
  override_balance?: number;
  override_effective_date?: string;
  override_note?: string;
}

/** Historical Balance Anchors V2 atomic apply. See balance_apply_import_v2. */
export async function applyImportBatchV2(
  batchId: string,
  rowResolutions: Record<number, RowResolution> = {},
): Promise<ImportApplyResult> {
  const { data, error } = await rpc("balance_apply_import_v2", {
    p_batch_id: batchId,
    p_row_resolutions: rowResolutions,
  });
  return unwrap<ImportApplyResult>(data, error);
}
