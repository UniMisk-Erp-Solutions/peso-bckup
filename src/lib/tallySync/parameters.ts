import { computeDetailedExpenseDateRange } from "@/lib/detailedExpenseReportFilters";
import type { TallySyncReportType } from "@/lib/tallyReportTypes";

export type ParsedTallyParameters = {
  category: string | null;
  userIds: string[] | null;
  singleUserId: string | null;
  engineerStatus: string | null;
  hoStatus: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  customFieldFilters: Record<string, string> | null;
};

export function parseTallyJobParameters(
  reportType: TallySyncReportType,
  raw: Record<string, unknown>,
): ParsedTallyParameters {
  const category = raw.category ? String(raw.category) : null;
  const singleUserId = raw.user_id ? String(raw.user_id) : null;
  const listed = Array.isArray(raw.user_ids) ? (raw.user_ids as string[]) : null;
  const userIds = singleUserId ? [singleUserId] : listed?.length ? listed : null;

  const hoStatus = raw.ho_status ? String(raw.ho_status) : null;
  if (reportType === "claim_approval" && hoStatus && hoStatus !== "approved") {
    throw new Error("Claim Approval Tally sync only supports HO status Approved.");
  }

  const custom =
    raw.custom_field_filters && typeof raw.custom_field_filters === "object"
      ? (raw.custom_field_filters as Record<string, string>)
      : null;

  return {
    category,
    userIds,
    singleUserId,
    engineerStatus: raw.engineer_status ? String(raw.engineer_status) : null,
    hoStatus,
    dateFrom: raw.date_from ? String(raw.date_from) : null,
    dateTo: raw.date_to ? String(raw.date_to) : null,
    customFieldFilters: custom,
  };
}

export function claimVerificationStatuses(engineerStatus: string | null): string[] {
  if (!engineerStatus || engineerStatus === "all") {
    return ["verified", "level_1_verified", "level_2_verified"];
  }
  return [engineerStatus];
}

export function claimApprovalRpcStatuses(): string[] {
  return ["approved"];
}

/** Maps Manager Approval UI values to expenses.approval_tier for approved rows (R3). */
export function engineerStatusToApprovalTier(engineerStatus: string): string | null {
  switch (engineerStatus) {
    case "verified":
      return "engineer";
    case "level_1_verified":
      return "team_leader";
    case "level_2_verified":
      return "executive";
    default:
      return null;
  }
}

/** Frozen year/month/week or explicit date_from/date_to → RPC window (Detailed Expense). */
export function resolveDetailedExpenseRpcDates(raw: Record<string, unknown>): {
  dateFrom: string | null;
  dateTo: string | null;
} {
  if (raw.date_from || raw.date_to) {
    return {
      dateFrom: raw.date_from ? String(raw.date_from) : null,
      dateTo: raw.date_to ? String(raw.date_to) : null,
    };
  }
  const year = raw.year ? String(raw.year) : "";
  const month = raw.month ? String(raw.month) : "all";
  const week = raw.week ? String(raw.week) : "all";
  const { dateFrom, dateTo } = computeDetailedExpenseDateRange(year, month, week);
  return { dateFrom, dateTo };
}
