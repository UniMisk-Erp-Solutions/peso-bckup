import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema, faqPageSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { Testimonials, CTASection, FAQAccordion } from "@/components/marketing/sections";
import {
  ReceiptIllustration,
  MockOrgChart,
  MockAuditLog,
} from "@/components/marketing/features";
import {
  LazyDemo,
  LazyInteractiveApprovalWorkflow,
  LazyInteractiveBalanceTransfer,
  LazyInteractiveDashboardPreview,
  LazyInteractiveExpenseFormPreview,
  LazyInteractiveReportPreview,
  LazyInteractiveTeamPreview,
} from "@/components/marketing/product/lazy";
import {
  ArrowRight,
  FileText,
  GitBranch,
  Wallet,
  Building2,
  BarChart3,
  Shield,
  CheckCircle2,
  FileCheck,
  Upload,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import type { FAQItem } from "@/components/marketing/sections";
import type { ReactNode } from "react";
import {
  ADAPT_SECTION,
  analyticsFeatures,
  auditFeatures,
  balanceFeatures,
  CTA_PRICING,
  expenseFeatures,
  featuresFaqItems,
  FEATURES_META_DESCRIPTION,
  multiorgFeatures,
  REPORTING_SECTION,
  workflowFeatures,
} from "@/lib/marketingCopy";

/* Feature category data. Major categories carry a playable preview; the rest a lighter illustration. */
const featureCategories: {
  id: string;
  title: string;
  description: string;
  icon: typeof FileText;
  features: readonly string[];
  demo: ReactNode;
}[] = [
  {
    id: "expense",
    title: "Expense Capture & Documentation",
    description:
      "Capture expenses with the details your finance team actually needs, from a form that adapts to the category. Bills and receipts stay attached to the expense they belong to, instead of living in a separate chat or inbox.",
    icon: FileText,
    features: expenseFeatures,
    demo: (
      <LazyDemo minHeight={520}>
        <LazyInteractiveExpenseFormPreview />
      </LazyDemo>
    ),
  },
  {
    id: "workflow",
    title: "Approval Workflows, Roles & Permissions",
    description:
      "Route spend through the review tiers your organization uses. Every tier is optional and configurable, and each role sees and acts only on what its permissions allow — enforced in the application and the database, not only on screen.",
    icon: GitBranch,
    features: workflowFeatures,
    demo: (
      <div className="space-y-6">
        <LazyDemo minHeight={460}>
          <LazyInteractiveApprovalWorkflow />
        </LazyDemo>
        <LazyDemo minHeight={330}>
          <LazyInteractiveTeamPreview />
        </LazyDemo>
      </div>
    ),
  },
  {
    id: "balance",
    title: "Balance Management",
    description: "Know where employee funds stand, from cash additions to transfers, returns and history.",
    icon: Wallet,
    features: balanceFeatures,
    demo: (
      <LazyDemo minHeight={330}>
        <LazyInteractiveBalanceTransfer />
      </LazyDemo>
    ),
  },
  {
    id: "multiorg",
    title: "Multi-Team & Organizational Management",
    description:
      "Structure expense management around your teams, departments, branches or entities. Access follows each user's active organization membership, and data stays isolated between organizations.",
    icon: Building2,
    features: multiorgFeatures,
    demo: <MockOrgChart />,
  },
  {
    id: "analytics",
    title: "Reporting & Expense Tracking",
    description:
      "Every expense carries a status — draft, submitted, under review, approved or rejected — so nothing sits in limbo. Month-aware dashboards and server-generated reports can be inspected in the browser before you export.",
    icon: BarChart3,
    features: analyticsFeatures,
    demo: (
      <LazyDemo minHeight={380}>
        <LazyInteractiveDashboardPreview />
      </LazyDemo>
    ),
  },
  {
    id: "audit",
    title: "Audit & Compliance",
    description: "Clear records of who did what and when, so reviews and audits do not depend on memory.",
    icon: Shield,
    features: auditFeatures,
    demo: <MockAuditLog />,
  },
];

const useCases = [
  {
    icon: FileCheck,
    title: "Office & field expenses",
    description:
      "Track daily office supplies, utilities, and miscellaneous expenses with proper documentation and approval workflows.",
  },
  {
    icon: Upload,
    title: "Travel Reimbursements",
    description:
      "Manage employee travel expenses with receipt uploads, multi-level approval, and automatic balance updates.",
  },
  {
    icon: Users,
    title: "Site Operations",
    description:
      "Handle on-site purchases with engineer verification before admin approval, perfect for field operations.",
  },
];

const faqItems: FAQItem[] = featuresFaqItems;

export default function FeaturesPage() {
  return (
    <MarketingShell>
      <SEOHead
        title="Expense management features | PesoWise"
        description={FEATURES_META_DESCRIPTION}
        canonicalUrl={absoluteUrl("/features")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Features", path: "/features" },
          ]),
          faqPageSchema(faqItems),
        ]}
      />
      {/* Hero */}
      <FullBleedBand variant="hero" className="py-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <ScrollReveal variant="fade-up">
            <h1 className="text-4xl font-bold leading-tight text-foreground md:text-5xl">
              Features built for real operations finance
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              From configurable expense forms and approval hierarchies to employee balances, month-aware dashboards and
              report preview, everything below is a playable preview you can try.
            </p>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.2}>
            <div className="relative flex items-center justify-center">
              <ReceiptIllustration className="h-48 w-auto" />
            </div>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      {/* Custom Workflows — the most important category, shown first */}
      <FullBleedBand variant="soft" className="py-16">
        <ScrollReveal className="mx-auto max-w-3xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">Custom Workflows</p>
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            PesoWise fits your workflow — not the other way around.
          </h2>
          <p className="text-muted-foreground leading-relaxed">{ADAPT_SECTION.body}</p>
        </ScrollReveal>
        <StaggerContainer className="mx-auto mt-8 grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-3">
          {ADAPT_SECTION.areas.map((area) => (
            <StaggerItem key={area}>
              <div className="flex h-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground shadow-soft">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" aria-hidden /> {area}
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
        <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-muted-foreground">{ADAPT_SECTION.scopeNote}</p>
        <ScrollReveal>
          <div className="mt-8 text-center">
            <Button asChild size="lg" className="btn-glow group">
              <Link to="/contact">
                {CTA_PRICING}
                <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden />
              </Link>
            </Button>
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* Feature Categories (6 blocks) */}
      {featureCategories.map((category, index) => {
        const Icon = category.icon;
        const isEven = index % 2 === 0;
        return (
          <FullBleedBand
            key={category.id}
            variant={isEven ? "transparent" : "soft"}
            className="py-16"
          >
            <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
              <ScrollReveal
                variant={isEven ? "fade-right" : "fade-left"}
                className={!isEven ? "lg:order-2" : undefined}
              >
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
                  <Icon className="h-6 w-6 text-primary" />
                </div>
                <h2 className="text-2xl font-bold text-foreground mb-3">{category.title}</h2>
                <p className="text-muted-foreground mb-6">{category.description}</p>
                <ul className="space-y-3">
                  {category.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-accent mt-0.5" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
              </ScrollReveal>
              <ScrollReveal
                variant={isEven ? "fade-left" : "fade-right"}
                delay={0.15}
                className={!isEven ? "lg:order-1" : undefined}
              >
                <div className="flex justify-center">
                  <div className="w-full max-w-xl min-w-0">{category.demo}</div>
                </div>
              </ScrollReveal>
            </div>
          </FullBleedBand>
        );
      })}

      {/* Reporting: full-width interactive report preview */}
      <FullBleedBand variant="hero" className="py-20">
        <ScrollReveal className="mx-auto mb-10 max-w-3xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{REPORTING_SECTION.heading}</h2>
          <p className="text-muted-foreground">{REPORTING_SECTION.body}</p>
        </ScrollReveal>
        <LazyDemo minHeight={560}>
          <LazyInteractiveReportPreview />
        </LazyDemo>
      </FullBleedBand>

      {/* Use Cases */}
      <FullBleedBand className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Built for your use case
          </h2>
        </ScrollReveal>
        <StaggerContainer className="grid gap-6 md:grid-cols-3">
          {useCases.map((uc, i) => {
            const Icon = uc.icon;
            return (
              <StaggerItem key={i}>
                <div className="rounded-xl border border-border bg-card p-6 shadow-soft card-hover h-full">
                  <div className="h-12 w-12 rounded-xl bg-accent/10 flex items-center justify-center mb-4">
                    <Icon className="h-6 w-6 text-accent" />
                  </div>
                  <h3 className="text-base font-semibold text-foreground mb-2">{uc.title}</h3>
                  <p className="text-sm text-muted-foreground">{uc.description}</p>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      </FullBleedBand>

      {/* FAQ */}
      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Frequently Asked Questions
          </h2>
        </ScrollReveal>
        <ScrollReveal delay={0.1}>
          <div className="max-w-3xl mx-auto">
            <FAQAccordion items={faqItems} />
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* Testimonials */}
      <FullBleedBand>
        <ScrollReveal>
          <Testimonials />
        </ScrollReveal>
      </FullBleedBand>

      {/* CTA */}
      <FullBleedBand className="py-20">
        <ScrollReveal variant="scale">
          <CTASection />
        </ScrollReveal>
      </FullBleedBand>
    </MarketingShell>
  );
}
