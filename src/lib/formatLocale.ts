import type { AppLanguage } from "@/i18n/config";
import { enIN } from "date-fns/locale/en-IN";
import { hi } from "date-fns/locale/hi";
import { gu } from "date-fns/locale/gu";
import type { Locale } from "date-fns";

/** BCP 47 locale for Intl date/number formatting. */
export function getDateLocale(language: string): string {
  switch (language) {
    case "hi":
      return "hi-IN";
    case "gu":
      return "gu-IN";
    default:
      return "en-IN";
  }
}

export function getIntlLocale(language: string): string {
  return getDateLocale(language);
}

/** date-fns locale for formatted dates in UI. */
export function getDateFnsLocale(language: string): Locale {
  switch (language as AppLanguage) {
    case "hi":
      return hi;
    case "gu":
      return gu;
    default:
      return enIN;
  }
}
