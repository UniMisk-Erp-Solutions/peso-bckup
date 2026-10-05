/**
 * Marketing refresh guards: stale/unsupported claims, required product
 * messaging, SEO integrity, screenshot ban and demo isolation.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import {
  APPROVAL_SECTION,
  HERO_HEADING,
  HOME_DESCRIPTION,
  HOME_FAQ_ITEMS,
  HOME_TITLE,
  MONTH_SECTION,
  PRICING_PLANS,
  REPORTING_SECTION,
  SCHEMA_FEATURE_LIST,
  SECURITY_ORG_ANSWER,
  FORM_SECTION,
  TEAMS_SECTION,
} from "../marketingCopy";
import { homepageGraphSchema } from "../schema/jsonLd";

const CR = String.fromCharCode(13);
const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf-8").split(CR).join("");

const PUBLIC_SOURCES = [
  "src/pages/marketing/HomePage.tsx",
  "src/pages/FeaturesPage.tsx",
  "src/pages/HowItWorksPage.tsx",
  "src/pages/PricingPage.tsx",
  "src/pages/SecurityPage.tsx",
  "src/lib/marketingCopy.ts",
  "src/lib/schema/jsonLd.ts",
  "index.html",
];
const allPublicText = PUBLIC_SOURCES.map(read).join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) {
      if (n === "__tests__") continue;
      walk(f, out);
    } else out.push(f);
  }
  return out;
}

describe("stale and unsupported claims are gone", () => {
  it("no 'one organization per user' assumption anywhere on the public site", () => {
    expect(allPublicText).not.toMatch(/each user belongs to one organization/i);
    expect(allPublicText).not.toMatch(/one org(anization)? per user/i);
    expect(SECURITY_ORG_ANSWER).toMatch(/active organization membership/);
  });
  it("no certification or superlative security claims", () => {
    expect(allPublicText).not.toMatch(/SOC ?2|ISO ?27001|HIPAA|bank-grade|enterprise-grade|PCI/i);
  });
  it("no unverifiable encryption claims and no ERP-integration overclaim in meta", () => {
    expect(allPublicText).not.toMatch(/encryption at rest|encrypted (file|receipt) storage|SSL\/TLS/i);
    expect(allPublicText).not.toMatch(/integrates with your erp/i);
  });
  it("no real customer or company names", () => {
    expect(allPublicText).not.toMatch(/microlink|patidar|mistry ?and ?shah/i);
  });
  it("no internal implementation language", () => {
    expect(allPublicText).not.toMatch(/\btrip_start\b|\bPostgREST\b|\bEdge Function\b|report_export_jobs|keyset|\bV4\b|reconciliation anchor|worker queue|expense field memory/i);
  });
  it("no internal test-scale numbers", () => {
    expect(allPublicText).not.toMatch(/21,649|2,930|22k rows|23,7\d\d/);
  });
  it("no unsupported free-price advertisement in structured data", () => {
    expect(JSON.stringify(homepageGraphSchema(HOME_FAQ_ITEMS))).not.toMatch(/"price"/);
  });
  it("does not market internal accounting/reliability details", () => {
    expect(allPublicText).not.toMatch(/historical opening balance|duplicate deduction|refresh token|GoTrue|maintenance control/i);
  });
});

describe("required product messaging is present", () => {
  const corpus = [APPROVAL_SECTION.body, HERO_HEADING, HOME_DESCRIPTION, REPORTING_SECTION.body, MONTH_SECTION.body, FORM_SECTION.body, TEAMS_SECTION.body, ...SCHEMA_FEATURE_LIST, ...HOME_FAQ_ITEMS.map((f) => f.answer)].join(" ");
  it("reporting", () => {
    expect(corpus).toMatch(/preview thousands of rows/);
    expect(corpus).toMatch(/report history|reopen previous generated reports/i);
    expect(corpus).toMatch(/CSV/);
  });
  it("month-aware dashboard", () => {
    expect(MONTH_SECTION.heading).toBe("See the month, not just the total");
    expect(MONTH_SECTION.body).toMatch(/month-end|end of that month|that month's end/i);
  });
  it("Recent values, described plainly and not as AI", () => {
    expect(FORM_SECTION.note).toBe("Recent values are personal to each employee.");
    expect(corpus).toMatch(/Recent values/);
    expect(allPublicText).not.toMatch(/AI[- ]suggest|smart AI|machine learning/i);
  });
  it("project / custom forms, hierarchy and My Teams", () => {
    expect(corpus).toMatch(/Project (IDs|and operational fields)/i);
    expect(corpus).toMatch(/supervisors?, team leaders?, engineers?, executives?/i);
    expect(TEAMS_SECTION.body).toMatch(/without receiving organization-wide administrator access/);
  });
  it("positions PesoWise as complementing the ERP, not replacing it", () => {
    const erp = HOME_FAQ_ITEMS.find((f) => /ERP/.test(f.question))!;
    expect(erp.answer).toMatch(/complements your ERP/);
  });
});

describe("pricing entitlements were not invented", () => {
  it("keeps the same three tiers and user limits; new capabilities are not placed behind a tier", () => {
    expect(PRICING_PLANS.map((p) => p.name)).toEqual(["Starter", "Growth", "Enterprise"]);
    const text = JSON.stringify(PRICING_PLANS);
    expect(text).not.toMatch(/report preview|month|recent values/i);
  });
});

describe("SEO", () => {
  const titles = [
    HOME_TITLE,
    ...["src/pages/FeaturesPage.tsx", "src/pages/HowItWorksPage.tsx", "src/pages/PricingPage.tsx", "src/pages/SecurityPage.tsx"].map(
      (p) => read(p).match(/title="([^"]+)"/)![1],
    ),
  ];
  it("every public page has a distinct title of sensible length", () => {
    expect(new Set(titles).size).toBe(titles.length);
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(70);
  });
  it("homepage description is within a snippet-friendly length", () => {
    expect(HOME_DESCRIPTION.length).toBeGreaterThan(100);
    expect(HOME_DESCRIPTION.length).toBeLessThanOrEqual(200);
  });
  it("homepage JSON-LD is valid JSON with exactly one FAQPage and the refreshed feature list", () => {
    const g = JSON.parse(JSON.stringify(homepageGraphSchema(HOME_FAQ_ITEMS)));
    const nodes = g["@graph"] as { "@type": string; featureList?: string[]; mainEntity?: unknown[] }[];
    expect(nodes.filter((n) => n["@type"] === "FAQPage")).toHaveLength(1);
    expect(nodes.find((n) => n["@type"] === "FAQPage")!.mainEntity).toHaveLength(HOME_FAQ_ITEMS.length);
    expect(nodes.find((n) => n["@type"] === "SoftwareApplication")!.featureList).toEqual([...SCHEMA_FEATURE_LIST]);
  });
  it("FAQ questions are unique and every answer is non-empty", () => {
    const qs = HOME_FAQ_ITEMS.map((f) => f.question);
    expect(new Set(qs).size).toBe(qs.length);
    for (const f of HOME_FAQ_ITEMS) expect(f.answer.trim().length).toBeGreaterThan(40);
  });
  it("static index.html meta matches the refreshed positioning", () => {
    const html = read("index.html");
    expect(html).toContain("Operations Expense Management Software");
    expect(html).not.toContain("Smart Expense &amp; Cash Flow Management");
  });
  it("the security FAQ has a single schema source (no duplicate FAQ definitions)", () => {
    const sec = read("src/pages/SecurityPage.tsx");
    expect(sec.match(/SECURITY_FAQ/g)!.length).toBeGreaterThanOrEqual(3);
    expect(sec.match(/"@type": "Question"/g)?.length).toBe(1);
  });
});

describe("screenshot ban and demo isolation", () => {
  const productFiles = walk(resolve(root, "src/components/marketing/product"));
  it("the product previews contain no image assets and no <img> of the application", () => {
    expect(productFiles.filter((f) => /\.(png|jpe?g|webp|gif|avif)$/i.test(f))).toEqual([]);
    for (const f of productFiles.filter((f) => /\.tsx?$/.test(f))) {
      const t = readFileSync(f, "utf-8");
      expect(t, f).not.toMatch(/<img\b|\.(png|jpe?g|webp|gif)["']/i);
    }
  });
  it("the previews import nothing from the authenticated app or any data source", () => {
    for (const f of productFiles.filter((f) => /\.tsx?$/.test(f))) {
      const t = readFileSync(f, "utf-8");
      expect(t, f).not.toMatch(/integrations\/supabase|contexts\/AuthContext|dashboardStats|reportExportJobs|@supabase|expenseService|useAuth\b|realtime|\bfetch\(/i);
    }
  });
  it("demo data contains only fictional names", () => {
    const d = readFileSync(resolve(root, "src/components/marketing/product/demoData.ts"), "utf-8");
    for (const n of ["Aarav Shah", "Riya Mehta", "Kabir Patel", "North Plant Upgrade", "Ahmedabad Office Setup", "Field Operations West"]) {
      expect(d).toContain(n);
    }
  });
});

describe("public routes stay public and below-the-fold demos are lazy", () => {
  it("the five marketing routes are not wrapped in ProtectedRoute", () => {
    const app = read("src/App.tsx");
    for (const path of ["/", "/features", "/how-it-works", "/pricing", "/security", "/contact"]) {
      const line = app.split("\n").find((l) => l.includes(`path="${path}"`))!;
      expect(line, path).toBeTruthy();
      expect(line, path).not.toMatch(/ProtectedRoute/);
    }
  });
  it("pages consume the previews through lazy wrappers only", () => {
    for (const p of ["src/pages/marketing/HomePage.tsx", "src/pages/FeaturesPage.tsx", "src/pages/HowItWorksPage.tsx"]) {
      const t = read(p);
      expect(t, p).toMatch(/marketing\/product\/lazy/);
      expect(t, p).not.toMatch(/from "@\/components\/marketing\/product"/);
    }
  });
});
