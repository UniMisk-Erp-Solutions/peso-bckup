export type ExpenseRowLike = {
  id: string;
  status?: string | null;
  category?: string | null;
  custom_fields?: Record<string, string>;
};

export type ExpenseMeta = {
  approval_tier?: string | null;
  deleted_at?: string | null;
};

export function isSoftDeleted(meta: ExpenseMeta | undefined): boolean {
  return Boolean(meta?.deleted_at);
}

export function matchesCustomFieldFilters(
  row: ExpenseRowLike,
  filters: Record<string, string> | null | undefined,
): boolean {
  if (!filters || !Object.keys(filters).length) return true;
  for (const [key, wanted] of Object.entries(filters)) {
    if (!wanted || wanted === "all") continue;
    const actual = String(row.custom_fields?.[key] ?? "").trim();
    if (actual !== wanted) return false;
  }
  return true;
}

export function matchesClaimApprovalEngineerFilter(
  expenseId: string,
  engineerStatus: string | null,
  metaById: Record<string, ExpenseMeta>,
): boolean {
  if (!engineerStatus || engineerStatus === "all") return true;
  const tierWanted = engineerStatus === "verified"
    ? "engineer"
    : engineerStatus === "level_1_verified"
      ? "team_leader"
      : engineerStatus === "level_2_verified"
        ? "executive"
        : null;
  if (!tierWanted) return true;
  const tier = metaById[expenseId]?.approval_tier ?? null;
  return tier === tierWanted;
}
