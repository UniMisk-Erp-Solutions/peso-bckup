import type { TallySyncReportType } from "../tallyReportTypes.ts";

/** Row stored in `tally_sync_job_items` (Phase 3). */
export type PreparedJobItem = {
  seq: number;
  source_type: "expense" | "balance_timeline" | "daily_report_row" | string;
  source_key: string;
  content_hash: string;
  payload: PreparedItemPayload;
};

export type PreparedItemPayload = {
  organization_id: string;
  report_type: TallySyncReportType;
  expense_id?: string;
  event_id?: string;
  track_date?: string;
  user_id?: string;
  project_id?: string;
  row?: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

export type DataClass = "accounting" | "report_metadata" | "derived_report";

export type TallyMasterKind = "ledger" | "cost_centre" | "voucher_type" | "group";

export type TallyMasterRef = {
  kind: TallyMasterKind;
  stable_key: string;
  display_name: string;
  parent_group?: string;
};

export type TallyVoucherAction = "create" | "alter";

export type TallyVoucherEntry = {
  ledger_key: string;
  amount: number;
  is_debit: boolean;
};

export type TallyVoucherModel = {
  accounting_key: string;
  voucher_type: string;
  voucher_number?: string;
  date: string;
  narration: string;
  entries: TallyVoucherEntry[];
  action: TallyVoucherAction;
  peso_expense_id?: string;
  peso_event_id?: string;
};

export type LedgerDisplayUdf = {
  name: string;
  index: string;
  value: string;
};

export type ReportMetadataRecord = {
  metadata_key: string;
  /** Deterministic Tally ledger name (PW-META-…). */
  ledger_name: string;
  /** When set (from `tally_delivery_state.tally_remote_id`), used for Alter import identity. */
  tally_master_guid?: string | null;
  action: "create" | "alter";
  schema_version: number;
  organization_id: string;
  report_type: TallySyncReportType;
  source_key: string;
  content_hash: string;
  accounting_key?: string;
  payload: Record<string, unknown>;
  /** Optional flat ledger UDFs (Daily Project TDL read model). */
  display_udfs?: LedgerDisplayUdf[];
};

export type TallyCommand =
  | { kind: "master"; master: TallyMasterRef; action: "create" | "alter" }
  | { kind: "voucher"; voucher: TallyVoucherModel }
  | { kind: "report_metadata"; metadata: ReportMetadataRecord };

export type DeliveryAction = "create" | "skip" | "update" | "cancel_planned";

export type DeliveryStateRow = {
  organization_id: string;
  delivery_key: string;
  delivery_kind: string;
  last_content_hash: string | null;
  /** Monotonic metadata revision for logical key K (append-only versions). */
  last_metadata_revision?: number | null;
  tally_remote_id: string | null;
  last_action: DeliveryAction | "pending";
  last_job_id: string | null;
  peso_deleted_at: string | null;
  cancel_strategy: string | null;
};

export type MapJobOptions = {
  organization_id: string;
  job_id: string;
  /** Existing delivery rows for this org (from DB or test fixture). */
  delivery_state?: DeliveryStateRow[];
  batch_size?: number;
  /** V2: metadata ledgers only — no vouchers (default on for production jobs). */
  presentation_only?: boolean;
  sync_run_id?: string;
};

export type TallyDeliveryUpdatePayload = {
  delivery_key: string;
  delivery_kind: string;
  content_hash: string;
  tally_remote_id?: string | null;
  last_action: string;
  metadata_revision?: number | null;
};

export type XmlBatch = {
  batch_index: number;
  message_count: number;
  xml: string;
  delivery_updates?: TallyDeliveryUpdatePayload[];
};

export type MapJobResult = {
  commands: TallyCommand[];
  decisions: Array<{
    delivery_key: string;
    action: DeliveryAction;
    content_hash: string;
  }>;
  accounting_voucher_count: number;
  xml_batches: XmlBatch[];
};
