/** Supabase Realtime allows one column filter per postgres_changes listener. */
export function userIdRealtimeFilter(userId: string): string {
  return `user_id=eq.${userId}`;
}

export function notificationMatchesOrg(
  payload: { new?: Record<string, unknown>; old?: Record<string, unknown> },
  organizationId: string | null | undefined,
): boolean {
  if (!organizationId) return true;
  const row = payload.new ?? payload.old;
  return String(row?.organization_id ?? "") === organizationId;
}
