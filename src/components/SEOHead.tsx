import { Helmet } from "react-helmet-async";
import { DEFAULT_OG_IMAGE, SITE_ORIGIN, BUSINESS } from "@/lib/siteConfig";
import { standaloneWebsiteSchema } from "@/lib/schema/jsonLd";

export interface SEOHeadProps {
  /** HTML <title> — keep ≤ ~60 characters for SERP display */
  title: string;
  /** Meta description — keep ≤ ~160 characters */
  description: string;
  /** Absolute canonical URL (required for indexable public pages) */
  canonicalUrl?: string;
  /** e.g. "noindex, nofollow" for auth, dashboards, 404 */
  robots?: string;
  ogImage?: string;
  ogType?: string;
  twitterCard?: "summary" | "summary_large_image";
  /**
   * One or more JSON-LD objects. Rendered as separate script tags.
   * Use dangerouslySetInnerHTML-safe JSON serialization.
   */
  structuredData?: object | object[];
  /** @deprecated Use structuredData array; kept for backward compatibility */
  faqSchema?: object;
  /** Homepage only — adds standalone WebSite JSON-LD for Google site name (avoid on inner pages). */
  includeWebsiteSchema?: boolean;
}

/**
 * App-wide head tags for public (and selectively private) routes.
 * Requires <HelmetProvider> in main.tsx.
 *
 * Google Search Console (site verification):
 * - Preferred: DNS TXT record in your domain registrar (no code deploy).
 * - Optional: set VITE_GSC_VERIFICATION to the content value of the meta tag
 *   Google gives you (not the whole tag — just the token string).
 */
export function SEOHead({
  title,
  description,
  canonicalUrl,
  robots,
  ogImage = DEFAULT_OG_IMAGE,
  ogType = "website",
  twitterCard = "summary_large_image",
  structuredData,
  faqSchema,
  includeWebsiteSchema = false,
}: SEOHeadProps) {
  const gsc = import.meta.env.VITE_GSC_VERIFICATION as string | undefined;

  const blocks: object[] = [];
  if (structuredData) {
    blocks.push(...(Array.isArray(structuredData) ? structuredData : [structuredData]));
  }
  if (faqSchema) {
    blocks.push(faqSchema);
  }

  return (
    <Helmet prioritizeSeoTags htmlAttributes={{ lang: "en" }}>
      <title>{title}</title>
      <meta name="description" content={description} />
      {robots ? <meta name="robots" content={robots} /> : <meta name="robots" content="index, follow" />}
      {canonicalUrl ? <link rel="canonical" href={canonicalUrl} /> : null}

      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content={ogType} />
      <meta property="og:image" content={ogImage} />
      <meta property="og:site_name" content={BUSINESS.productName} />
      <meta name="application-name" content={BUSINESS.productName} />
      <meta name="apple-mobile-web-app-title" content={BUSINESS.productName} />
      <meta property="og:locale" content="en_US" />
      {canonicalUrl ? <meta property="og:url" content={canonicalUrl} /> : null}

      <meta name="twitter:card" content={twitterCard} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={ogImage} />

      {gsc ? <meta name="google-site-verification" content={gsc} /> : null}

      {includeWebsiteSchema ? (
        <script
          key="seo-ld-website"
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(standaloneWebsiteSchema()) }}
        />
      ) : null}

      {blocks.map((data, i) => (
        <script
          key={`seo-ld-${i}`}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
        />
      ))}
    </Helmet>
  );
}

/** Site origin for rare cases where components need it outside Helmet */
export function getDefaultSiteOrigin(): string {
  return SITE_ORIGIN;
}
