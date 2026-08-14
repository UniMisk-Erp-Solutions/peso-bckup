/** Browser cache for employee_id -> auth email (avoids repeat DB lookups on same device). */

const PREFIX = "pesowise:emp-email:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(organizationId: string, employeeId: string) {
  return `${PREFIX}${organizationId}:${employeeId.trim().toLowerCase()}`;
}

export function getCachedEmployeeAuthEmail(
  organizationId: string,
  employeeId: string,
): string | null {
  try {
    const raw = localStorage.getItem(cacheKey(organizationId, employeeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: string; exp?: number };
    if (!parsed.email || !parsed.exp || Date.now() > parsed.exp) {
      localStorage.removeItem(cacheKey(organizationId, employeeId));
      return null;
    }
    return parsed.email;
  } catch {
    return null;
  }
}

export function setCachedEmployeeAuthEmail(
  organizationId: string,
  employeeId: string,
  email: string,
): void {
  try {
    localStorage.setItem(
      cacheKey(organizationId, employeeId),
      JSON.stringify({ email, exp: Date.now() + TTL_MS }),
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearCachedEmployeeAuthEmail(organizationId: string, employeeId: string): void {
  try {
    localStorage.removeItem(cacheKey(organizationId, employeeId));
  } catch {
    /* ignore */
  }
}
