/**
 * Which active organization_membership row is "the current one" for a user.
 *
 * A user can hold several active memberships (e.g. an admin in one
 * organization and an employee in another). Resolving role/organization with
 * `.maybeSingle()` over ALL of them errors out (PGRST116) or picks an
 * arbitrary row for such a user, so the app must select the row belonging to
 * the user's current organization -- their profile's organization_id -- and
 * only fall back to the first row when no current organization is known.
 */
export function pickCurrentMembership<T extends { organization_id?: string | null }>(
  rows: readonly T[] | null | undefined,
  currentOrganizationId: string | null | undefined,
): T | null {
  if (!rows || rows.length === 0) return null;
  if (currentOrganizationId) {
    const match = rows.find((r) => r.organization_id === currentOrganizationId);
    if (match) return match;
  }
  return rows[0];
}
