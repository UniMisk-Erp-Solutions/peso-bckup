/**
 * Cookie consent storage and helpers.
 * GDPR-aligned: necessary always true; analytics/marketing default false.
 */

export const CONSENT_STORAGE_KEY = "pw_cookie_consent_v1";

export interface CookieConsent {
  version: number;
  necessary: true;
  analytics: boolean;
  marketing: boolean;
  updatedAt: string;
}

const defaultConsent: CookieConsent = {
  version: 1,
  necessary: true,
  analytics: false,
  marketing: false,
  updatedAt: new Date().toISOString(),
};

export function getConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CookieConsent;
    if (parsed.version !== 1 || parsed.necessary !== true) return null;
    return {
      ...defaultConsent,
      ...parsed,
      necessary: true,
    };
  } catch {
    return null;
  }
}

export function setConsent(partial: Partial<Pick<CookieConsent, "analytics" | "marketing">>): CookieConsent {
  const current = getConsent() ?? defaultConsent;
  const next: CookieConsent = {
    ...current,
    ...partial,
    necessary: true,
    updatedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export function hasConsentBeenSet(): boolean {
  return getConsent() !== null;
}
