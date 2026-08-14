export const SUPPORTED_LANGUAGES = ["en", "hi", "gu"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: AppLanguage = "en";

export const LANGUAGE_LABELS: Record<AppLanguage, string> = {
  en: "English",
  hi: "हिन्दी",
  gu: "ગુજરાતી",
};

export const I18N_NAMESPACES = [
  "common",
  "auth",
  "nav",
  "dashboard",
  "expenses",
  "admin",
  "balances",
  "settings",
  "reports",
  "notifications",
  "master",
  "help",
  "validation",
  "analytics",
  "cashier",
  "transfers",
  "debugReview",
] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export function normalizeAppLanguage(value: string | null | undefined): AppLanguage {
  const v = (value || "").trim().toLowerCase();
  if (v === "hi" || v === "gu") return v;
  return "en";
}

export function getEnabledLanguagesFromEnv(): AppLanguage[] {
  const raw = import.meta.env.VITE_I18N_LANGS as string | undefined;
  if (!raw?.trim()) return [...SUPPORTED_LANGUAGES];
  const parsed = raw
    .split(",")
    .map((s) => normalizeAppLanguage(s))
    .filter((lang, i, arr) => arr.indexOf(lang) === i);
  return parsed.length > 0 ? parsed : [...SUPPORTED_LANGUAGES];
}
