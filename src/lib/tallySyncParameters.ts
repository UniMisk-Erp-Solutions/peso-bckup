/**
 * Frozen report context for Tally sync jobs (Phase 2).
 * Aligns with report_export_jobs parameters where export exists; additionally
 * captures UI-only filters for Phase 3 parity (Phase 1 R2/R3).
 */
import { activeCustomFieldFilters } from "@/lib/detailedExpenseReportFilters";
import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export const TALLY_SYNC_CONTEXT_VERSION = 1;

export type BuildTallySyncParametersInput = {
  reportType: TallySyncReportType;
  category?: string | null;
  userId?: string | null;
  userIds?: string[] | null;
  engineerStatus?: string | null;
  hoStatus?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  customFieldFilters?: Record<string, string>;
  selectedYear?: string;
  selectedMonth?: string;
  selectedWeek?: string;
};

/**
 * Server-bound parameters only — no row data, pagination, or preview state.
 */
export function buildTallySyncParameters(
  input: BuildTallySyncParametersInput,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    context_version: TALLY_SYNC_CONTEXT_VERSION,
  };

  if (input.category && input.category !== "all") params.category = input.category;
  if (input.userId && input.userId !== "all") params.user_id = input.userId;
  if (input.userIds?.length) params.user_ids = input.userIds;

  if (input.engineerStatus && input.engineerStatus !== "all") {
    params.engineer_status = input.engineerStatus;
  }
  if (input.hoStatus && input.hoStatus !== "all") {
    params.ho_status = input.hoStatus;
  }

  if (input.dateFrom) params.date_from = input.dateFrom;
  if (input.dateTo) params.date_to = input.dateTo;

  const custom = input.customFieldFilters
    ? activeCustomFieldFilters(input.customFieldFilters)
    : {};
  if (Object.keys(custom).length) {
    params.custom_field_filters = custom;
  }

  if (input.selectedYear) params.year = input.selectedYear;
  if (input.selectedMonth && input.selectedMonth !== "all") params.month = input.selectedMonth;
  if (input.selectedWeek && input.selectedWeek !== "all") params.week = input.selectedWeek;

  /** New job per Sync click (does not cancel prior in-flight jobs on the connector). */
  params.sync_run_id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // Phase 3 dataset processor must interpret these; export parity documented in Phase 2 doc.
  if (input.reportType === "claim_verification" || input.reportType === "claim_approval") {
    params.export_parity = {
      custom_field_filters_in_report_export: false,
      claim_approval_engineer_status_in_report_export:
        input.reportType === "claim_approval" ? false : undefined,
    };
  }

  return params;
}
