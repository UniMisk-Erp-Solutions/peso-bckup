import type { AppLanguage, I18nNamespace } from "./config";
import { I18N_NAMESPACES } from "./config";

type ResourceBundle = Record<string, Record<string, unknown>>;

const localeLoaders: Record<AppLanguage, () => Promise<ResourceBundle>> = {
  en: async () => {
    const entries = await Promise.all(
      I18N_NAMESPACES.map(async (ns) => {
        const mod = await import(`../locales/en/${ns}.json`);
        return [ns, mod.default] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
  hi: async () => {
    const entries = await Promise.all(
      I18N_NAMESPACES.map(async (ns) => {
        const mod = await import(`../locales/hi/${ns}.json`);
        return [ns, mod.default] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
  gu: async () => {
    const entries = await Promise.all(
      I18N_NAMESPACES.map(async (ns) => {
        const mod = await import(`../locales/gu/${ns}.json`);
        return [ns, mod.default] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
};

const cache: Partial<Record<AppLanguage, ResourceBundle>> = {};

export async function loadLanguageResources(lang: AppLanguage): Promise<ResourceBundle> {
  if (cache[lang]) return cache[lang]!;
  const bundle = await localeLoaders[lang]();
  cache[lang] = bundle;
  return bundle;
}

export async function preloadLanguage(lang: AppLanguage): Promise<void> {
  await loadLanguageResources(lang);
}
