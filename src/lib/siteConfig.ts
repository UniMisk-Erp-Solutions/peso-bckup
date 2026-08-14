/**
 * Public marketing site configuration (canonical host, NAP, social placeholders).
 * Override with VITE_* env vars in production without code changes.
 */

function normalizeSiteOrigin(input: string): string {
  const trimmed = String(input || "").trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  url.protocol = "https:";
  if (url.hostname.startsWith("www.")) {
    url.hostname = url.hostname.slice(4);
  }
  url.hash = "";
  url.search = "";
  return `${url.origin}`;
}

export const SITE_ORIGIN = normalizeSiteOrigin(
  import.meta.env.VITE_PUBLIC_SITE_URL || "https://pesowise.unimisk.com"
);

/** Default Open Graph / Twitter image (replace with final 1200×630 asset if needed). */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/HERO.png`;

export function absoluteUrl(pathname: string): string {
  const p = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${SITE_ORIGIN}${p}`;
}

/** Legal / product naming for schema and footer copy */
export const BUSINESS = {
  legalName: "Unimisk",
  productName: "PesoWise",
  displayName: "PesoWise by Unimisk",
  contactEmail: "info@unimisk.com",
  /** First number is primary for tel: links */
  phoneTel: "+919426049048",
  phoneDisplay: ["+91 9426049048", "+91 8160325372", "+91 80008 45035"] as const,
  addressLines: [
    "10th Floor, Stratum@Venus Ground, Nr. Jhansi Rani Statue",
    "C-1008, West wing, Nehru Nagar",
    "Ahmedabad, Gujarat 380015",
    "India",
  ] as const,
  addressStructured: {
    streetAddress:
      "10th Floor, Stratum@Venus Ground, Nr. Jhansi Rani Statue, C-1008, West wing, Nehru Nagar",
    addressLocality: "Ahmedabad",
    addressRegion: "Gujarat",
    postalCode: "380015",
    addressCountry: "IN",
  },
  areaServed: "India; remote teams worldwide",
} as const;

/**
 * Social profiles — set VITE_SOCIAL_* in env for production URLs.
 * Empty string = omit link in footer (placeholder not yet live).
 */
export const SOCIAL_URLS = {
  linkedin:
    import.meta.env.VITE_SOCIAL_LINKEDIN_URL || "https://www.linkedin.com/company/pesowise",
  twitter: import.meta.env.VITE_SOCIAL_TWITTER_URL || "https://twitter.com/pesowise",
  instagram: import.meta.env.VITE_SOCIAL_INSTAGRAM_URL || "",
  youtube: import.meta.env.VITE_SOCIAL_YOUTUBE_URL || "",
} as const;

export { MARKETING_TAGLINE } from "@/lib/marketingCopy";

