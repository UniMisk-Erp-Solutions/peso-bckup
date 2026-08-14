import { useState } from "react";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema, faqPageSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { Testimonials, CTASection, FAQAccordion } from "@/components/marketing/sections";
import {
  ReceiptIllustration,
  MockExpenseForm,
  MockExpenseCard,
  MockWorkflowDiagram,
  MockBalanceTransfer,
  MockOrgChart,
  MockAnalyticsDashboard,
  MockAuditLog,
  MockApprovalTimeline,
  type MockExpenseFormData,
} from "@/components/marketing/features";
import {
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
  type LucideIcon,
} from "lucide-react";
import type { FAQItem } from "@/components/marketing/sections";
import {
  analyticsFeatures,
  auditFeatures,
  balanceFeatures,
  expenseFeatures,
  featuresFaqItems,
  FEATURES_META_DESCRIPTION,
  multiorgFeatures,
  workflowFeatures,
} from "@/lib/marketingCopy";

/* Feature category data */
const featureCategories = [
  {
    id: "expense",
    title: "Expense Management",
    description:
      "Complete expense tracking from creation to approval with full documentation support.",
    icon: FileText,
    features: expenseFeatures,
    mockComponent: MockExpenseCard,
  },
  {
    id: "workflow",
    title: "Approval Workflow",
    description:
      "Structured approval process with role-based permissions and configurable stages.",
    icon: GitBranch,
    features: workflowFeatures,
    mockComponent: MockWorkflowDiagram,
  },
  {
    id: "balance",
    title: "Balance Management",
    description:
      "Real-time balance tracking and control across all your expense accounts.",
    icon: Wallet,
    features: balanceFeatures,
    mockComponent: MockBalanceTransfer,
  },
  {
    id: "multiorg",
    title: "Multi-Organization Support",
    description:
      "Manage multiple branches or entities independently with complete data isolation.",
    icon: Building2,
    features: multiorgFeatures,
    mockComponent: MockOrgChart,
  },
  {
    id: "analytics",
    title: "Analytics & Reporting",
    description:
      "Insights and exports for better decision making and budget management.",
    icon: BarChart3,
    features: analyticsFeatures,
    mockComponent: MockAnalyticsDashboard,
  },
  {
    id: "audit",
    title: "Audit & Compliance",
    description:
      "Complete audit trails for accountability and regulatory compliance.",
    icon: Shield,
    features: auditFeatures,
    mockComponent: MockAuditLog,
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
  const [productTourSubmittedExpense, setProductTourSubmittedExpense] = useState<MockExpenseFormData | null>(null);

  return (
    <MarketingShell>
      <SEOHead
        title="Expense software features | PesoWise"
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
              Features built for real expense workflows
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              Everything from custom form fields and hierarchy approvals to balances, transfer offers, batch entry, and audit trails—structured, secure, and organization-ready.
            </p>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.2}>
            <div className="relative flex items-center justify-center">
              <ReceiptIllustration className="h-48 w-auto" />
              <div className="absolute -right-4 top-1/2 -translate-y-1/2">
                <MockExpenseForm />
              </div>
            </div>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      {/* Feature Categories (6 blocks) */}
      {featureCategories.map((category, index) => {
        const Icon = category.icon;
        const MockComponent = category.mockComponent;
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
                  <div className="w-full max-w-sm">
                    <MockComponent />
                  </div>
                </div>
              </ScrollReveal>
            </div>
          </FullBleedBand>
        );
      })}

      {/* Product Tour */}
      <FullBleedBand variant="hero" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            See it in action
          </h2>
          <p className="text-muted-foreground">Interactive previews of key workflows</p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-8 md:grid-cols-3">
          <StaggerItem>
            <p className="mb-4 text-center text-sm font-medium text-muted-foreground">
              Submit Expense
            </p>
            <MockExpenseForm onSubmit={(data) => setProductTourSubmittedExpense(data)} />
          </StaggerItem>
          <StaggerItem>
            <p className="mb-4 text-center text-sm font-medium text-muted-foreground">
              Track Approval
            </p>
            <MockApprovalTimeline submittedExpense={productTourSubmittedExpense} />
          </StaggerItem>
          <StaggerItem>
            <p className="mb-4 text-center text-sm font-medium text-muted-foreground">
              Manage Balances
            </p>
            <MockBalanceTransfer />
          </StaggerItem>
        </StaggerContainer>
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
