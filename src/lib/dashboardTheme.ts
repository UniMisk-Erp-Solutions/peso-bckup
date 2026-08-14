/**
 * Optional dashboard theme switch. "legacy" is the original dashboard; "old-money" is the
 * private-banking ("Old Money") shell. Persisted in localStorage and broadcast so every
 * component (Dashboard, Layout, Settings) reacts instantly without a reload.
 */

export type DashboardTheme = "legacy" | "old-money";

const STORAGE_KEY = "pesowise-dashboard-theme";
const EVENT = "pesowise-dashboard-theme-change";

export const DASHBOARD_THEME_LABELS: Record<DashboardTheme, string> = {
  legacy: "Legacy",
  "old-money": "Old Money",
};

export function getDashboardTheme(): DashboardTheme {
  if (typeof window === "undefined") return "legacy";
  try {
    return localStorage.getItem(STORAGE_KEY) === "old-money" ? "old-money" : "legacy";
  } catch {
    return "legacy";
  }
}

export function setDashboardTheme(theme: DashboardTheme): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore storage errors
  }
  window.dispatchEvent(new CustomEvent<DashboardTheme>(EVENT, { detail: theme }));
}

/** Subscribe to theme changes (same-tab custom event + cross-tab storage event). */
export function subscribeDashboardTheme(listener: (theme: DashboardTheme) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (e: Event) => listener((e as CustomEvent<DashboardTheme>).detail);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener(getDashboardTheme());
  };
  window.addEventListener(EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}
