import type { TallySyncReportType } from "../tallyReportTypes.ts";
import { classifyTimelineEvent, hoApprovalLabel, managerApprovalLabel } from "./classify.ts";
import { decideDelivery } from "./deliveryDecision.ts";
import type { DeliveryAction } from "./types.ts";
import {
  accountingBalanceEventKey,
  accountingExpenseKey,
  categoryLedgerKey,
  deterministicLedgerName,
  employeeLedgerKey,
  metadataVersionLedgerName,
  projectCostCentreKey,
  reportMetadataDeliveryKey,
  slugifyCategory,
  tallyMetadataDeliveryHash,
} from "./identities.ts";
import { buildDailyProjectLedgerUdks } from "./dailyProjectLedgerUdks.ts";
import { buildCommonMetaDisplayUdks } from "./metaDisplayUdks.ts";
import { buildClaimReportFlatRow, buildDetailedReportFlatRow } from "./reportDisplayRows.ts";
import { buildMetadataV1 } from "./metadataSchema.ts";
import { nextMetadataRevision } from "./metadataRevision.ts";
import { expenseIdFromPrepared, unwrapPreparedRow } from "./payload.ts";
import type { AccountingRegistry } from "./accountingRegistry.ts";
import type {
  DeliveryStateRow,
  PreparedJobItem,
  ReportMetadataRecord,
  TallyCommand,
  TallyMasterRef,
} from "./types.ts";

const EXPENSE_VOUCHER_TYPE = "PesoWise Expense";
const BALANCE_VOUCHER_TYPE = "PesoWise Balance";

function metadataLedgerCommand(
  metaKey: string,
  metaDecision: DeliveryAction,
  base: Omit<ReportMetadataRecord, "metadata_key" | "ledger_name" | "action" | "tally_master_guid">,
  stateByKey: Map<string, DeliveryStateRow>,
  forceRefresh?: boolean,
): TallyCommand | null {
  if (metaDecision === "skip" && !forceRefresh) return null;

  const prev = stateByKey.get(metaKey);
  const action: "create" | "alter" = metaDecision === "update" ? "alter" : "create";
  const ledgerHash = base.content_hash;
  const ledger_name = metadataVersionLedgerName(metaKey, ledgerHash);
  const tally_master_guid =
    action === "alter" && prev?.tally_remote_id ? prev.tally_remote_id : null;

  return {
    kind: "report_metadata",
    metadata: {
      ...base,
      metadata_key: metaKey,
      ledger_name,
      action,
      tally_master_guid,
    },
  };
}

function employeeMaster(orgId: string, userId: string, row: Record<string, unknown>): TallyMasterRef {
  const name = String(row.user_name ?? row.employee_name ?? "Employee");
  const code = String(row.employee_id ?? row.employee_code ?? "");
  return {
    kind: "ledger",
    stable_key: employeeLedgerKey(orgId, userId),
    display_name: deterministicLedgerName("PW-Emp", userId, code ? `${name} (${code})` : name),
    parent_group: "Current Liabilities",
  };
}

function categoryMaster(orgId: string, category: string): TallyMasterRef {
  const slug = slugifyCategory(category);
  return {
    kind: "ledger",
    stable_key: categoryLedgerKey(orgId, slug),
    display_name: deterministicLedgerName("PW-Cat", slug, category || "Uncategorized"),
    parent_group: "PesoWise Expenses",
  };
}

function projectMaster(orgId: string, projectId: string, name: string): TallyMasterRef {
  return {
    kind: "cost_centre",
    stable_key: projectCostCentreKey(orgId, projectId),
    display_name: deterministicLedgerName("PW-Proj", projectId, name || "Project"),
  };
}

function expenseVoucherDate(row: Record<string, unknown>): string {
  const d = row.trip_start ?? row.created_at ?? row.effective_date;
  if (d == null) return new Date().toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

type MapItemCtx = {
  force_metadata_refresh?: boolean;
  presentation_only?: boolean;
  sync_run_id?: string;
};

function mapClaimExpenseItem(
  item: PreparedJobItem,
  orgId: string,
  reportType: TallySyncReportType,
  registry: AccountingRegistry,
  stateByKey: Map<string, DeliveryStateRow>,
  mapCtx?: MapItemCtx,
): TallyCommand[] {
  const forceRefresh = mapCtx?.force_metadata_refresh === true;
  const envelope = item.payload;
  const row = unwrapPreparedRow(envelope);
  const expenseId = expenseIdFromPrepared(envelope);
  if (!expenseId) return [];

  const userId = String(row.user_id ?? "");
  const category = String(row.category ?? "");
  const amount = Number(row.total_amount ?? 0);
  const acctKey = accountingExpenseKey(orgId, expenseId);
  const metaKey = reportMetadataDeliveryKey(orgId, reportType, item.source_key);

  const commands: TallyCommand[] = [];
  const presentationOnly = mapCtx?.presentation_only === true;

  const metaDeliveryHash = tallyMetadataDeliveryHash(item.content_hash);
  const metaDecision = decideDelivery(metaKey, metaDeliveryHash, stateByKey);
  if (metaDecision !== "skip" || forceRefresh) {
    const metadata_revision = nextMetadataRevision(metaKey, metaDecision, stateByKey, metaDeliveryHash);
    const meta = buildMetadataV1({
      organization_id: orgId,
      report_type: reportType,
      metadata_delivery_key: metaKey,
      metadata_version_ledger_name: metadataVersionLedgerName(metaKey, metaDeliveryHash),
      metadata_revision,
      source_key: item.source_key,
      content_hash: item.content_hash,
      accounting_key: acctKey,
      expense_id: expenseId,
      user_id: userId || undefined,
      manager_approval: managerApprovalLabel(reportType, String(row.status ?? "")),
      ho_approval: hoApprovalLabel(reportType),
      workflow_status: String(row.status ?? ""),
      fields: {
        transaction_number: row.transaction_number,
        purpose: row.purpose,
        destination: row.destination,
        batch_ref: row.batch_ref,
        custom_fields: row.custom_fields ?? {},
        title: row.title,
        trip_start: row.trip_start,
        trip_end: row.trip_end,
        user_name: row.user_name,
        user_email: row.user_email,
        employee_id: row.employee_id,
        total_amount: row.total_amount,
        category: row.category,
        status: row.status,
        created_at: row.created_at,
        opening_balance: row.opening_balance,
        closing_balance: row.closing_balance,
      },
    });
    const claimFlat =
      reportType === "claim_verification" || reportType === "claim_approval"
        ? buildClaimReportFlatRow(row, reportType)
        : "";
    const metaCmd = metadataLedgerCommand(
      metaKey,
      metaDecision,
      {
        schema_version: 1,
        organization_id: orgId,
        report_type: reportType,
        source_key: item.source_key,
        content_hash: metaDeliveryHash,
        accounting_key: acctKey,
        payload: meta as unknown as Record<string, unknown>,
        display_udfs: [...buildCommonMetaDisplayUdks(meta, claimFlat, mapCtx?.sync_run_id)],
      },
      stateByKey,
      forceRefresh,
    );
    if (metaCmd) commands.push(metaCmd);
  }

  if (presentationOnly) return commands;

  if (userId) commands.push({ kind: "master", master: employeeMaster(orgId, userId, row), action: "create" });
  commands.push({ kind: "master", master: categoryMaster(orgId, category), action: "create" });

  const acctDecision = decideDelivery(acctKey, item.content_hash, stateByKey);
  const voucherAction = registry.planExpenseVoucher(acctKey, acctDecision);
  if (voucherAction) {
    const catMaster = categoryMaster(orgId, category);
    const empMaster = userId ? employeeMaster(orgId, userId, row) : catMaster;
    commands.push({
      kind: "voucher",
      voucher: {
        accounting_key: acctKey,
        voucher_type: EXPENSE_VOUCHER_TYPE,
        voucher_number: row.transaction_number ? String(row.transaction_number) : undefined,
        date: expenseVoucherDate(row),
        narration: String(row.purpose ?? row.title ?? "PesoWise expense"),
        peso_expense_id: expenseId,
        action: voucherAction,
        entries: [
          { ledger_key: catMaster.display_name, amount: Math.abs(amount), is_debit: true },
          { ledger_key: empMaster.display_name, amount: Math.abs(amount), is_debit: false },
        ],
      },
    });
  }

  return commands;
}

function mapDetailedItem(
  item: PreparedJobItem,
  orgId: string,
  registry: AccountingRegistry,
  stateByKey: Map<string, DeliveryStateRow>,
  mapCtx?: MapItemCtx,
): TallyCommand[] {
  const forceRefresh = mapCtx?.force_metadata_refresh === true;
  const envelope = item.payload;
  const row = unwrapPreparedRow(envelope);
  const eventType = String(row.event_type ?? "");
  const cls = classifyTimelineEvent(eventType);
  const eventId = String(envelope.event_id ?? row.event_id ?? "");
  const expenseId = row.expense_id ? String(row.expense_id) : null;
  const userId = String(row.user_id ?? "");
  const commands: TallyCommand[] = [];

  const metaKey = reportMetadataDeliveryKey(orgId, "detailed_expense", item.source_key);
  const acctKeyForExpense = expenseId ? accountingExpenseKey(orgId, expenseId) : undefined;

  const metaDeliveryHash = tallyMetadataDeliveryHash(item.content_hash);
  const metaDecision = decideDelivery(metaKey, metaDeliveryHash, stateByKey);
  if (metaDecision !== "skip" || forceRefresh) {
    const metadata_revision = nextMetadataRevision(metaKey, metaDecision, stateByKey, metaDeliveryHash);
    const meta = buildMetadataV1({
      organization_id: orgId,
      report_type: "detailed_expense",
      metadata_delivery_key: metaKey,
      metadata_version_ledger_name: metadataVersionLedgerName(metaKey, metaDeliveryHash),
      metadata_revision,
      source_key: item.source_key,
      content_hash: item.content_hash,
      accounting_key: acctKeyForExpense ?? (eventId ? accountingBalanceEventKey(orgId, eventId) : undefined),
      expense_id: expenseId ?? undefined,
      event_id: eventId || undefined,
      user_id: userId || undefined,
      fields: {
        event_type: eventType,
        event_label: row.event_label,
        effective_date: row.effective_date,
        credit: row.credit,
        debit: row.debit,
        opening_balance: row.opening_balance,
        closing_balance: row.closing_balance,
        category: row.category,
        purpose: row.purpose,
        destination: row.destination,
        custom_fields: row.custom_fields ?? {},
        note: row.note,
        modern_deduction_present: row.modern_deduction_present,
        employee_name: row.employee_name,
        employee_code: row.employee_code,
        transaction_number: row.transaction_number,
        title: row.title,
        batch_ref: row.batch_ref,
      },
    });
    const detailedFlat = buildDetailedReportFlatRow(row);
    const metaCmd = metadataLedgerCommand(
      metaKey,
      metaDecision,
      {
        schema_version: 1,
        organization_id: orgId,
        report_type: "detailed_expense",
        source_key: item.source_key,
        content_hash: metaDeliveryHash,
        accounting_key: acctKeyForExpense,
        payload: meta as unknown as Record<string, unknown>,
        display_udfs: [...buildCommonMetaDisplayUdks(meta, detailedFlat, mapCtx?.sync_run_id)],
      },
      stateByKey,
      forceRefresh,
    );
    if (metaCmd) commands.push(metaCmd);
  }

  if (mapCtx?.presentation_only === true) return commands;

  if (cls.linksExpenseAccounting && expenseId) {
    const acctKey = accountingExpenseKey(orgId, expenseId);
    const category = String(row.category ?? "");
    if (userId) commands.push({ kind: "master", master: employeeMaster(orgId, userId, row), action: "create" });
    commands.push({ kind: "master", master: categoryMaster(orgId, category), action: "create" });
    const amount = Number(row.debit ?? row.credit ?? 0);
    const acctDecision = decideDelivery(acctKey, item.content_hash, stateByKey);
    const voucherAction = registry.planExpenseVoucher(acctKey, acctDecision);
    if (voucherAction && amount !== 0) {
      const catMaster = categoryMaster(orgId, category);
      const empMaster = userId ? employeeMaster(orgId, userId, row) : catMaster;
      commands.push({
        kind: "voucher",
        voucher: {
          accounting_key: acctKey,
          voucher_type: EXPENSE_VOUCHER_TYPE,
          date: expenseVoucherDate(row),
          narration: String(row.note ?? row.title ?? "Expense deduction"),
          peso_expense_id: expenseId,
          action: voucherAction,
          entries: [
            { ledger_key: catMaster.display_name, amount: Math.abs(amount), is_debit: true },
            { ledger_key: empMaster.display_name, amount: Math.abs(amount), is_debit: false },
          ],
        },
      });
    }
    return commands;
  }

  if (cls.emitsAccountingVoucher && eventId) {
    const acctKey = accountingBalanceEventKey(orgId, eventId);
    const debit = Number(row.debit ?? 0);
    const credit = Number(row.credit ?? 0);
    const amount = debit || credit;
    if (amount > 0) {
      if (userId) commands.push({ kind: "master", master: employeeMaster(orgId, userId, row), action: "create" });
      const acctDecision = decideDelivery(acctKey, item.content_hash, stateByKey);
      const voucherAction = registry.planBalanceEventVoucher(acctKey, acctDecision);
      if (voucherAction) {
        const empMaster = userId
          ? employeeMaster(orgId, userId, row)
          : categoryMaster(orgId, "Employee pool");
        commands.push({
          kind: "voucher",
          voucher: {
            accounting_key: acctKey,
            voucher_type: BALANCE_VOUCHER_TYPE,
            date: expenseVoucherDate(row),
            narration: String(row.event_label ?? eventType),
            peso_event_id: eventId,
            action: voucherAction,
            entries: debit
              ? [{ ledger_key: empMaster.display_name, amount: debit, is_debit: true }]
              : [{ ledger_key: empMaster.display_name, amount: credit, is_debit: false }],
          },
        });
      }
    }
  }

  return commands;
}

/** Controlled E2E: metadata ledger only (no employee/project masters). */
export function mapDailyMetadataLedgerOnly(
  item: PreparedJobItem,
  orgId: string,
  stateByKey: Map<string, DeliveryStateRow>,
  mapCtx?: MapItemCtx,
): TallyCommand[] {
  const forceRefresh = mapCtx?.force_metadata_refresh === true;
  const envelope = item.payload;
  const row = unwrapPreparedRow(envelope);
  const userId = String(envelope.user_id ?? row.user_id ?? "");
  const projectId = String(envelope.project_id ?? row.project_id ?? "");
  const metaKey = reportMetadataDeliveryKey(orgId, "daily_project_report", item.source_key);
  const metaDeliveryHash = tallyMetadataDeliveryHash(item.content_hash);
  const metaDecision = decideDelivery(metaKey, metaDeliveryHash, stateByKey);
  if (metaDecision === "skip" && !forceRefresh) return [];

  const sourceExpenses = Array.isArray(row.source_expenses) ? row.source_expenses : [];
  const metadata_revision = nextMetadataRevision(metaKey, metaDecision, stateByKey, metaDeliveryHash);
  const meta = buildMetadataV1({
    organization_id: orgId,
    report_type: "daily_project_report",
    metadata_delivery_key: metaKey,
    metadata_version_ledger_name: metadataVersionLedgerName(metaKey, metaDeliveryHash),
    metadata_revision,
    source_key: item.source_key,
    content_hash: item.content_hash,
    user_id: userId || undefined,
    project_id: projectId || undefined,
    fields: {
      track_date: envelope.track_date ?? row.track_date,
      location: row.location,
      costs: row.costs,
      percent: row.percent,
      projects_in_employee_day: row.projects_in_employee_day,
      remarks: row.remarks,
      voucher_no: row.voucher_no,
      source_expenses_count: sourceExpenses.length,
      derived: true,
      project_name: row.project_name,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
    },
  });

  const metaCmd = metadataLedgerCommand(
    metaKey,
    metaDecision,
    {
      schema_version: 1,
      organization_id: orgId,
      report_type: "daily_project_report",
      source_key: item.source_key,
      content_hash: metaDeliveryHash,
      payload: meta as unknown as Record<string, unknown>,
      display_udfs: buildDailyProjectLedgerUdks(meta, row, mapCtx?.sync_run_id),
    },
    stateByKey,
    forceRefresh,
  );
  return metaCmd ? [metaCmd] : [];
}

function mapDailyItem(
  item: PreparedJobItem,
  orgId: string,
  stateByKey: Map<string, DeliveryStateRow>,
  mapCtx?: MapItemCtx,
): TallyCommand[] {
  return mapDailyMetadataLedgerOnly(item, orgId, stateByKey, mapCtx);
}

export function mapPreparedItem(
  item: PreparedJobItem,
  registry: AccountingRegistry,
  stateByKey: Map<string, DeliveryStateRow>,
  mapCtx?: MapItemCtx,
): TallyCommand[] {
  const orgId = item.payload.organization_id;
  const reportType = item.payload.report_type;

  if (item.source_type === "expense" || reportType === "claim_verification" || reportType === "claim_approval") {
    return mapClaimExpenseItem(item, orgId, reportType, registry, stateByKey, mapCtx);
  }
  if (item.source_type === "balance_timeline" || reportType === "detailed_expense") {
    return mapDetailedItem(item, orgId, registry, stateByKey, mapCtx);
  }
  if (item.source_type === "daily_report_row" || reportType === "daily_project_report") {
    return mapDailyItem(item, orgId, stateByKey, mapCtx);
  }
  return [];
}

export { EXPENSE_VOUCHER_TYPE, BALANCE_VOUCHER_TYPE };
