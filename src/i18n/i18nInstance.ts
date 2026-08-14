import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import {
  DEFAULT_LANGUAGE,
  I18N_NAMESPACES,
  normalizeAppLanguage,
  type AppLanguage,
} from "./config";
import { loadLanguageResources } from "./loadResources";

let initPromise: Promise<void> | null = null;

export async function ensureI18nInitialized(): Promise<void> {
  if (i18n.isInitialized) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const enBundle = await loadLanguageResources("en");

    await i18n
      .use(LanguageDetector)
      .use(initReactI18next)
      .init({
        resources: { en: enBundle },
        lng: DEFAULT_LANGUAGE,
        fallbackLng: DEFAULT_LANGUAGE,
        supportedLngs: ["en", "hi", "gu"],
        ns: [...I18N_NAMESPACES],
        defaultNS: "common",
        interpolation: { escapeValue: true },
        returnEmptyString: false,
        returnNull: false,
        detection: {
          order: ["localStorage"],
          caches: ["localStorage"],
          lookupLocalStorage: "pesowise_lang_preview",
        },
        react: { useSuspense: false },
        saveMissing: import.meta.env.DEV,
        missingKeyHandler: import.meta.env.DEV
          ? (_lngs, ns, key) => {
              console.warn(`[i18n] missing key: ${ns}:${key}`);
            }
          : undefined,
      });
  })();

  return initPromise;
}

export async function changeAppLanguage(lang: AppLanguage): Promise<void> {
  await ensureI18nInitialized();
  const normalized = normalizeAppLanguage(lang);
  if (!i18n.hasResourceBundle(normalized, "common")) {
    const bundle = await loadLanguageResources(normalized);
    for (const ns of I18N_NAMESPACES) {
      i18n.addResourceBundle(normalized, ns, bundle[ns], true, true);
    }
  }
  await i18n.changeLanguage(normalized);
  if (typeof document !== "undefined") {
    document.documentElement.lang = normalized;
  }
}

export { i18n };
