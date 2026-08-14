import { supabase } from "@/integrations/supabase/client";
import { fetchProfileNamesByUserIds } from "@/lib/supabaseInQuery";

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

const ACTION_LABELS: Record<string, string> = {
  expense_created: "Expense created",
  expense_submitted: "Expense submitted",
  expense_resubmitted: "Expense resubmitted",
  expense_assigned: "Expense assigned",
  expense_verified: "Expense verified",
  expense_approved: "Expense approved",
  expense_rejected: "Expense rejected",
  expense_corrected_by_reviewer: "Expense adjusted by reviewer",
  tier_advanced: "Hierarchy verification step completed",
};

export type AuditLogRow = {
  user_id: string;
  action: string;
  comment?: string | null;
  created_at: string;
};

export type EnrichedAuditLog = {
  action: string;
  user_name: string;
  comment?: string;
  created_at: string;
};

export function extractUuidsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const matches = text.match(UUID_REGEX);
  if (!matches) return [];
  return [...new Set(matches.map((id) => id.toLowerCase()))];
}

export function resolveUuidsInText(
  text: string,
  nameByUserId: Map<string, string>,
): string {
  return text.replace(UUID_REGEX, (uuid) => {
    const name = nameByUserId.get(uuid.toLowerCase());
    return name ?? "Unknown user";
  });
}

/** Human-readable timeline title from `audit_logs.action`. */
export function formatAuditLogAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  return action.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
}

export function getAuditLogStatusColors(action: string) {
  const actionLower = action.toLowerCase();
  if (actionLower.includes("approved")) {
    return {
      dot: "bg-green-500",
      line: "bg-green-200",
      text: "text-green-700",
      bg: "bg-green-50",
      border: "border-green-200",
    };
  }
  if (actionLower.includes("verified")) {
    return {
      dot: "bg-yellow-500",
      line: "bg-yellow-200",
      text: "text-yellow-700",
      bg: "bg-yellow-50",
      border: "border-yellow-200",
    };
  }
  if (actionLower.includes("rejected")) {
    return {
      dot: "bg-red-500",
      line: "bg-red-200",
      text: "text-red-700",
      bg: "bg-red-50",
      border: "border-red-200",
    };
  }
  if (actionLower.includes("resubmitted")) {
    return {
      dot: "bg-blue-500",
      line: "bg-blue-200",
      text: "text-blue-700",
      bg: "bg-blue-50",
      border: "border-blue-200",
    };
  }
  if (actionLower.includes("submitted")) {
    return {
      dot: "bg-indigo-500",
      line: "bg-indigo-200",
      text: "text-indigo-700",
      bg: "bg-indigo-50",
      border: "border-indigo-200",
    };
  }
  if (actionLower.includes("created")) {
    return {
      dot: "bg-gray-500",
      line: "bg-gray-200",
      text: "text-gray-700",
      bg: "bg-gray-50",
      border: "border-gray-200",
    };
  }
  return {
    dot: "bg-purple-500",
    line: "bg-purple-200",
    text: "text-purple-700",
    bg: "bg-purple-50",
    border: "border-purple-200",
  };
}

/** Resolve actor + UUIDs embedded in comments to display names. */
export async function enrichAuditLogsWithDisplay(
  logs: AuditLogRow[],
): Promise<EnrichedAuditLog[]> {
  if (logs.length === 0) return [];

  const userIds = new Set<string>();
  for (const log of logs) {
    userIds.add(log.user_id);
    for (const id of extractUuidsFromText(log.comment)) {
      userIds.add(id);
    }
  }

  const nameByUserId = await fetchProfileNamesByUserIds(supabase, [...userIds]);

  return logs.map((log) => ({
    action: log.action,
    user_name: nameByUserId.get(log.user_id.toLowerCase()) || "Unknown user",
    comment: log.comment
      ? resolveUuidsInText(String(log.comment), nameByUserId)
      : undefined,
    created_at: log.created_at,
  }));
}
