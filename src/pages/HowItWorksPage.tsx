import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema, faqPageSchema } from "@/lib/schema/jsonLd";
import { HOW_IT_WORKS_META_DESCRIPTION, workflowFaqItems } from "@/lib/marketingCopy";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { CTASection, FAQAccordion } from "@/components/marketing/sections";
import { LazyDemo, LazyInteractiveHowItWorksTour } from "@/components/marketing/product/lazy";
import {
  FileText,
  Settings2,
  ThumbsUp,
  Wallet,
  ClipboardCheck,
  BarChart3,
  User,
  Wrench,
  Shield,
  Coins,
  CheckCircle2,
  Users,
  Crown,
  ListChecks,
} from "lucide-react";

const implementationInputs = [
  "Current expense process",
  "Departments and employee roles",
  "Approval structure",
  "Expense categories",
  "Reporting requirements",
  "Branches or entities",
  "Internal policies",
  "Required integrations",
];

const workflowSteps = [
  {
    label: "Configure",
    description: "Admins set categories, required fields and workflow rules",
    icon: Settings2,
    color: "bg-primary text-primary-foreground",
  },
  {
    label: "Capture",
    description: "Employees submit expenses with receipts and operational or project details",
    icon: FileText,
    color: "bg-violet-600 text-white",
  },
  {
    label: "Review",
    description: "Supervisors, team leaders, engineers or executives review where configured",
    icon: Users,
    color: "bg-warning text-warning-foreground",
  },
  {
    label: "Approve",
    description: "An authorized approver approves or rejects with full context",
    icon: ThumbsUp,
    color: "bg-accent text-accent-foreground",
  },
  {
    label: "Balance",
    description: "Approved spend affects the relevant balance and its history",
    icon: Wallet,
    color: "bg-info text-info-foreground",
  },
  {
    label: "Report",
    description: "Finance reviews dashboards and generates audit-ready reports",
    icon: BarChart3,
    color: "bg-primary text-primary-foreground",
  },
];

const roles = [
  {
    role: "Employee",
    icon: User,
    color: "bg-primary/10 text-primary",
    responsibilities: [
      "Create and submit expense reports with custom fields",
      "Upload receipts and documentation",
      "Track expense status in real-time",
    ],
    mockAction: "Submit Expense Report",
  },
  {
    role: "Manager / Team Leader",
    icon: Crown,
    color: "bg-violet-500/10 text-violet-700",
    responsibilities: [
      "Review team member expenses in My Teams",
      "Act as hierarchy reviewer when assigned",
      "Export team-scoped reports",
    ],
    mockAction: "Review Team Expenses",
  },
  {
    role: "Engineer",
    icon: Wrench,
    color: "bg-warning/10 text-warning",
    responsibilities: [
      "Verify expenses on-site when required",
      "Add verification notes and comments",
      "Forward verified expenses for approval",
    ],
    mockAction: "Verify & Forward",
  },
  {
    role: "Admin",
    icon: Shield,
    color: "bg-accent/10 text-accent",
    responsibilities: [
      "Final approval with complete visibility",
      "Configure form builder and hierarchy tiers",
      "Access comprehensive reports and exports",
    ],
    mockAction: "Approve Expense",
  },
  {
    role: "Cashier",
    icon: Coins,
    color: "bg-info/10 text-info",
    responsibilities: [
      "Manage expense fund balances",
      "Send transfer offers or direct allocations",
      "Handle return requests",
    ],
    mockAction: "Send Transfer Offer",
  },
  {
    role: "Executive",
    icon: Users,
    color: "bg-slate-500/10 text-slate-700",
    responsibilities: [
      "Optional executive-tier review before admin",
      "Supervisor-first routing when configured",
      "Visibility into escalated approvals",
    ],
    mockAction: "Executive Review",
  },
];

export default function HowItWorksPage() {
  return (
    <MarketingShell>
      <SEOHead
        title="How PesoWise expense workflows work | PesoWise"
        description={HOW_IT_WORKS_META_DESCRIPTION}
        canonicalUrl={absoluteUrl("/how-it-works")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "How it works", path: "/how-it-works" },
          ]),
          faqPageSchema(workflowFaqItems),
        ]}
      />
      <FullBleedBand variant="hero" className="py-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <ScrollReveal variant="fade-up" className="min-w-0">
            <h1 className="mb-6 text-4xl font-bold leading-tight text-foreground md:text-5xl">
              From configuration to audit-ready reports, one expense at a time
            </h1>
            <p className="text-lg text-muted-foreground">
              A structured workflow with optional supervisor, team leader, engineer and executive tiers. Click through one
              expense to see how it is configured, captured, reviewed, approved and reported.
            </p>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.2} className="min-w-0">
            <LazyDemo minHeight={430}>
              <LazyInteractiveHowItWorksTour />
            </LazyDemo>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            The PesoWise Workflow
          </h2>
          <p className="text-muted-foreground">
            Six steps from configuration to audit-ready reporting
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            One example flow — your organization can configure its own stages, reviewers and fields.
          </p>
        </ScrollReveal>
        <div className="relative">
          <div className="absolute top-8 left-0 right-0 h-0.5 bg-border hidden lg:block" aria-hidden />
          <StaggerContainer className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
            {workflowSteps.map((step, i) => {
              const Icon = step.icon;
              return (
                <StaggerItem key={i}>
                  <div className="relative flex flex-col items-center text-center">
                    <div
                      className={`relative z-10 mb-4 flex h-16 w-16 items-center justify-center rounded-2xl shadow-soft ${step.color}`}
                    >
                      <Icon className="h-8 w-8" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground mb-2">{step.label}</h3>
                    <p className="text-sm text-muted-foreground">{step.description}</p>
                  </div>
                </StaggerItem>
              );
            })}
          </StaggerContainer>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Role-based Experience
          </h2>
          <p className="text-muted-foreground">
            Each role sees what it needs, including project and custom fields on review
          </p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {roles.map((role, i) => {
            const Icon = role.icon;
            return (
              <StaggerItem key={i}>
                <div className="rounded-xl border border-border bg-card p-6 shadow-soft card-hover h-full">
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${role.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-base font-semibold text-foreground">{role.role}</h3>
                  </div>
                  <ul className="mb-4 space-y-2">
                    {role.responsibilities.map((resp, j) => (
                      <li key={j} className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-accent mt-0.5" />
                        <span className="text-xs text-muted-foreground">{resp}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="pt-4 border-t border-border">
                    <div className="rounded-lg bg-muted/50 px-3 py-2 text-center text-xs font-medium text-muted-foreground">
                      {role.mockAction}
                    </div>
                  </div>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      </FullBleedBand>

      {/* Configure PesoWise around your company */}
      <FullBleedBand className="py-20">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <ScrollReveal variant="fade-right">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <ListChecks className="h-6 w-6 text-primary" aria-hidden />
            </div>
            <h2 className="mb-3 text-2xl font-bold text-foreground md:text-3xl">
              Configure PesoWise around your company
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Implementation starts by understanding how your organization actually handles expenses today, then
              configuring PesoWise around that, rather than asking you to adopt a fixed template.
            </p>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.1}>
            <ul className="grid gap-3 sm:grid-cols-2">
              {implementationInputs.map((item) => (
                <li key={item} className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground shadow-soft">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" aria-hidden /> {item}
                </li>
              ))}
            </ul>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Workflow FAQs
          </h2>
        </ScrollReveal>
        <ScrollReveal delay={0.1}>
          <div className="max-w-3xl mx-auto">
            <FAQAccordion items={workflowFaqItems} />
          </div>
        </ScrollReveal>
      </FullBleedBand>

      <FullBleedBand className="py-20">
        <ScrollReveal variant="scale">
          <CTASection />
        </ScrollReveal>
      </FullBleedBand>
    </MarketingShell>
  );
}
