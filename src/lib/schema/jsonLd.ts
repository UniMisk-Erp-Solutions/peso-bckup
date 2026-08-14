/**
 * JSON-LD builders for public pages. Keep payloads factual; avoid keyword stuffing.
 */

import {
  SITE_ORIGIN,
  DEFAULT_OG_IMAGE,
  BUSINESS,
  SOCIAL_URLS,
} from "@/lib/siteConfig";
import { SCHEMA_FEATURE_LIST } from "@/lib/marketingCopy";

const sameAs = [
  SOCIAL_URLS.linkedin,
  SOCIAL_URLS.twitter,
  SOCIAL_URLS.instagram,
  SOCIAL_URLS.youtube,
].filter(Boolean);

/** Google Search site name — https://developers.google.com/search/docs/appearance/site-names */
export function standaloneWebsiteSchema(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: BUSINESS.productName,
    alternateName: [BUSINESS.displayName, "pesowise.unimisk.com"],
    url: `${SITE_ORIGIN}/`,
  };
}

function organizationNode(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": `${SITE_ORIGIN}/#organization`,
    name: BUSINESS.productName,
    alternateName: BUSINESS.displayName,
    legalName: BUSINESS.legalName,
    url: SITE_ORIGIN,
    logo: {
      "@type": "ImageObject",
      url: DEFAULT_OG_IMAGE,
    },
    email: BUSINESS.contactEmail,
    telephone: BUSINESS.phoneTel,
    address: {
      "@type": "PostalAddress",
      streetAddress: BUSINESS.addressStructured.streetAddress,
      addressLocality: BUSINESS.addressStructured.addressLocality,
      addressRegion: BUSINESS.addressStructured.addressRegion,
      postalCode: BUSINESS.addressStructured.postalCode,
      addressCountry: BUSINESS.addressStructured.addressCountry,
    },
    areaServed: BUSINESS.areaServed,
    sameAs,
  };
}

function softwareApplicationNode(): Record<string, unknown> {
  return {
    "@type": "SoftwareApplication",
    "@id": `${SITE_ORIGIN}/#software`,
    name: BUSINESS.productName,
    applicationCategory: "FinanceApplication",
    operatingSystem: "Web",
    url: SITE_ORIGIN,
    description:
      "PesoWise helps organizations manage employee expenses, hierarchy approvals, custom category fields, balances, and audit-ready records—designed to complement your ERP and finance systems.",
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "INR",
      availability: "https://schema.org/InStock",
    },
    publisher: { "@id": `${SITE_ORIGIN}/#organization` },
    image: DEFAULT_OG_IMAGE,
    featureList: [...SCHEMA_FEATURE_LIST],
  };
}

function localBusinessNode(): Record<string, unknown> {
  return {
    "@type": "LocalBusiness",
    "@id": `${SITE_ORIGIN}/#local`,
    name: BUSINESS.displayName,
    image: DEFAULT_OG_IMAGE,
    url: SITE_ORIGIN,
    telephone: BUSINESS.phoneTel,
    email: BUSINESS.contactEmail,
    priceRange: "$$",
    address: {
      "@type": "PostalAddress",
      streetAddress: BUSINESS.addressStructured.streetAddress,
      addressLocality: BUSINESS.addressStructured.addressLocality,
      addressRegion: BUSINESS.addressStructured.addressRegion,
      postalCode: BUSINESS.addressStructured.postalCode,
      addressCountry: BUSINESS.addressStructured.addressCountry,
    },
    areaServed: BUSINESS.areaServed,
    sameAs,
  };
}

export function faqPageSchema(
  items: ReadonlyArray<{ question: string; answer: string }>
) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

export function breadcrumbSchema(
  items: ReadonlyArray<{ name: string; path: string }>
) {
  const origin = SITE_ORIGIN;
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => {
      const p = item.path.startsWith("/") ? item.path : `/${item.path}`;
      return {
        "@type": "ListItem",
        position: index + 1,
        name: item.name,
        item: `${origin}${p}`,
      };
    }),
  };
}

/** Homepage: Organization + SoftwareApplication + LocalBusiness + FAQ (inline FAQPage entity in graph is OK as separate node) */
export function homepageGraphSchema(
  faq: ReadonlyArray<{ question: string; answer: string }>
) {
  const graph: Record<string, unknown>[] = [
    organizationNode(),
    softwareApplicationNode(),
    localBusinessNode(),
  ];
  if (faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${SITE_ORIGIN}/#faq`,
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: item.answer,
        },
      })),
    });
  }
  return {
    "@context": "https://schema.org",
    "@graph": graph,
  };
}
