import { useEffect, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { DEFAULT_LANGUAGE } from "./config";
import { changeAppLanguage, ensureI18nInitialized, i18n } from "./i18nInstance";

export function I18nProvider({ children }: { children: ReactNode }) {
  const { preferredLanguage, loading, user } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void ensureI18nInitialized().then(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (loading && user) return;
    const lang = user ? preferredLanguage : DEFAULT_LANGUAGE;
    void changeAppLanguage(lang);
  }, [ready, preferredLanguage, loading, user]);

  if (!ready) return null;

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
