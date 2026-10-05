import { lazy, Suspense } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { SEOHead } from "@/components/SEOHead";
import { FAQAccordion } from "@/components/marketing/sections";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { homepageGraphSchema } from "@/lib/schema/jsonLd";
import {
  ADAPT_SECTION,
  APPROVAL_SECTION,
  BALANCE_SECTION,
  CAPABILITY_CARDS,
  COMPARISON_SECTION,
  CTA_PRIMARY,
  CTA_SECONDARY,
  FORM_SECTION,
  HERO_BODY,
  HERO_CAPABILITY_LINE,
  HERO_HEADING,
  HERO_SUBLINE,
  HOME_DESCRIPTION,
  HOME_FAQ_ITEMS,
  HOME_TITLE,
  MONTH_SECTION,
  PROBLEM_SECTION,
  REPORTING_SECTION,
  TEAMS_SECTION,
  USE_CASES,
} from "@/lib/marketingCopy";
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
  BarChart3,
  Briefcase,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Factory,
  FileText,
  GitBranch,
  HardHat,
  MapPin,
  Shield,
  Sprout,
  TrendingUp,
  Users,
  Wallet,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

const LogoWall = lazy(() =>
  import("@/components/marketing/sections/LogoWall").then((m) => ({ default: m.LogoWall }))
);
const Testimonials = lazy(() =>
  import("@/components/marketing/sections/Testimonials").then((m) => ({ default: m.Testimonials }))
);
const CTASection = lazy(() =>
  import("@/components/marketing/sections/CTASection").then((m) => ({ default: m.CTASection }))
);

const capabilityIcons: Record<string, LucideIcon> = {
  forms: ClipboardList,
  approvals: GitBranch,
  balances: Wallet,
  projects: FileText,
  months: CalendarRange,
  reporting: BarChart3,
};

const useCaseIcons: LucideIcon[] = [Factory, HardHat, MapPin, Briefcase, Sprout];

const howItWorksSteps = [
  { step: "1", title: "Configure", description: "Admins set categories, required fields and review rules", icon: ClipboardList },
  { step: "2", title: "Capture", description: "Employees submit with receipts and project details", icon: FileText },
  { step: "3", title: "Review", description: "Supervisors, team leaders, engineers or executives review where configured", icon: Users },
  { step: "4", title: "Approve", description: "An authorized approver decides with full context", icon: CheckCircle2 },
  { step: "5", title: "Balance", description: "Approved spend reduces the relevant balance and is kept in history", icon: Wallet },
  { step: "6", title: "Report", description: "Finance reviews dashboards and generates audit-ready reports", icon: BarChart3 },
];

const whyPesoWise = [
  {
    icon: Zap,
    title: "Reviews that follow your hierarchy",
    description: "Optional supervisor, team leader, engineer and executive tiers move expenses to the right person without giving everyone admin access.",
  },
  {
    icon: TrendingUp,
    title: "Balances you can trust",
    description: "Cash additions, transfer offers and approved spend stay in step across roles and locations, with history to look back on.",
  },
  {
    icon: Shield,
    title: "Audit-ready records",
    description: "Approvals, project details and report history keep who did what, and when, easy to show at month-end.",
  },
];

function CopyBlock({ heading, body, children }: { heading: string; body: string; children?: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{heading}</h2>
      <p className="text-muted-foreground leading-relaxed">{body}</p>
      {children}
    </div>
  );
}

const HomePage = () => {
  const canonical = absoluteUrl("/");
  const structuredData = homepageGraphSchema(HOME_FAQ_ITEMS);

  return (
    <MarketingShell>
      <SEOHead
        title={HOME_TITLE}
        description={HOME_DESCRIPTION}
        canonicalUrl={canonical}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={structuredData}
      />

      {/* Hero */}
      <FullBleedBand variant="hero" className="py-16 md:py-24">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-12">
          <ScrollReveal variant="fade-up">
            <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">PesoWise</p>
            <h1 className="mb-5 text-4xl font-bold leading-tight tracking-tight text-foreground md:text-5xl lg:text-[2.6rem]">
              {HERO_HEADING}
            </h1>
            <p className="mb-3 text-lg text-muted-foreground md:text-xl">{HERO_BODY}</p>
            <p className="mb-4 text-sm text-muted-foreground/90">{HERO_SUBLINE}</p>
            <p className="mb-8 text-sm font-medium text-foreground/80">{HERO_CAPABILITY_LINE}</p>
            <div className="flex flex-col gap-4 sm:flex-row">
              <Button asChild size="lg" className="btn-glow group">
                <Link to="/contact">
                  {CTA_PRIMARY}
                  <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/how-it-works">{CTA_SECONDARY}</Link>
              </Button>
            </div>
            <p className="mt-6 text-sm text-muted-foreground">
              <Link to="/features" className="font-medium text-primary underline-offset-4 hover:underline">
                Explore features
              </Link>
              {" · "}
              <Link to="/pricing" className="font-medium text-primary underline-offset-4 hover:underline">
                Pricing
              </Link>
              {" · "}
              <Link to="/security" className="font-medium text-primary underline-offset-4 hover:underline">
                Security
              </Link>
              {" · "}
              <Link to="/auth" className="font-medium text-primary underline-offset-4 hover:underline">
                Login
              </Link>
            </p>
          </ScrollReveal>

          <ScrollReveal variant="fade-left" delay={0.2} className="min-w-0">
            <LazyDemo minHeight={380}>
              <LazyInteractiveDashboardPreview />
            </LazyDemo>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      {/* Problem */}
      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="mx-auto mb-10 max-w-3xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{PROBLEM_SECTION.heading}</h2>
          <p className="text-muted-foreground">{PROBLEM_SECTION.intro}</p>
        </ScrollReveal>
        <StaggerContainer className="mx-auto grid max-w-4xl gap-3 sm:grid-cols-2">
          {PROBLEM_SECTION.items.map((item) => (
            <StaggerItem key={item}>
              <div className="flex h-full items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                  <X className="h-3.5 w-3.5 text-destructive" aria-hidden />
                </span>
                <span className="text-sm text-foreground">{item}</span>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
        <ScrollReveal>
          <p className="mx-auto mt-8 max-w-2xl text-center text-base font-medium text-foreground">
            {PROBLEM_SECTION.transition}
          </p>
        </ScrollReveal>
      </FullBleedBand>

      {/* Old way vs PesoWise */}
      <FullBleedBand className="py-20">
        <ScrollReveal className="mx-auto mb-10 max-w-3xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{COMPARISON_SECTION.heading}</h2>
          <p className="text-muted-foreground">{COMPARISON_SECTION.body}</p>
        </ScrollReveal>
        <div className="mx-auto grid max-w-3xl gap-6 sm:grid-cols-2">
          <div className="rounded-2xl border border-border bg-muted/30 p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {COMPARISON_SECTION.oldWay.label}
            </h3>
            <ul className="space-y-3">
              {COMPARISON_SECTION.oldWay.items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden /> {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-primary">
              {COMPARISON_SECTION.pesowise.label}
            </h3>
            <ul className="space-y-3">
              {COMPARISON_SECTION.pesowise.items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-sm text-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /> {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </FullBleedBand>

      {/* Adaptability — the core product philosophy */}
      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="mx-auto mb-10 max-w-3xl text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-primary">{ADAPT_SECTION.kicker}</p>
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{ADAPT_SECTION.heading}</h2>
          <p className="text-muted-foreground leading-relaxed">{ADAPT_SECTION.body}</p>
        </ScrollReveal>

        <div className="mx-auto mb-10 grid max-w-3xl gap-4 sm:grid-cols-3">
          {ADAPT_SECTION.examples.map((ex) => (
            <div key={ex.label} className="rounded-xl border border-border bg-card p-4 shadow-soft">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{ex.label}</p>
              <ol className="space-y-1.5">
                {ex.steps.map((s, i) => (
                  <li key={s} className="flex items-center gap-2 text-sm text-foreground">
                    {i > 0 && <span className="text-muted-foreground" aria-hidden>↓</span>}
                    {i === 0 && <span className="w-3" aria-hidden />}
                    {s}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <p className="mx-auto mb-10 max-w-3xl text-center text-xs text-muted-foreground">{ADAPT_SECTION.disclaimer}</p>

        <StaggerContainer className="mx-auto grid max-w-4xl grid-cols-2 gap-3 sm:grid-cols-3">
          {ADAPT_SECTION.areas.map((area) => (
            <StaggerItem key={area}>
              <div className="flex h-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-foreground shadow-soft">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" aria-hidden /> {area}
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
        <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-muted-foreground">{ADAPT_SECTION.scopeNote}</p>
      </FullBleedBand>

      {/* Built for real operations finance */}
      <FullBleedBand className="py-20">
        <ScrollReveal className="mb-12 text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">Built for real operations finance</h2>
          <p className="mx-auto max-w-2xl text-muted-foreground">
            Operations expense management for organizations with real approval hierarchies, employee cash balances,
            project-level data and serious reporting requirements.
          </p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {CAPABILITY_CARDS.map((card) => {
            const Icon = capabilityIcons[card.id] ?? FileText;
            return (
              <StaggerItem key={card.id}>
                <div className="card-hover h-full rounded-xl border border-border bg-card p-6 shadow-soft">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" aria-hidden />
                  </div>
                  <h3 className="mb-2 text-base font-semibold text-foreground">{card.title}</h3>
                  <p className="text-sm text-muted-foreground">{card.description}</p>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <ScrollReveal variant="fade-right" className="min-w-0">
            <CopyBlock heading={FORM_SECTION.heading} body={FORM_SECTION.body}>
              <ul className="mt-5 space-y-2 text-sm text-muted-foreground">
                {["Fields that change with the category", "Fields that appear after a selection", "Project details that fill together"].map((t) => (
                  <li key={t} className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /> {t}
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-sm font-medium text-foreground/80">{FORM_SECTION.note}</p>
            </CopyBlock>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.1} className="min-w-0">
            <LazyDemo minHeight={520}>
              <LazyInteractiveExpenseFormPreview />
            </LazyDemo>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-20">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <ScrollReveal variant="fade-right" className="lg:order-2">
            <CopyBlock heading={APPROVAL_SECTION.heading} body={APPROVAL_SECTION.body}>
              <p className="mt-4 text-sm font-medium text-foreground/80">
                Your approval process doesn&apos;t have to change for PesoWise — PesoWise can be configured around it.
              </p>
            </CopyBlock>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.1} className="lg:order-1">
            <LazyDemo minHeight={460}>
              <LazyInteractiveApprovalWorkflow />
            </LazyDemo>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="mx-auto mb-10 max-w-3xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{REPORTING_SECTION.heading}</h2>
          <p className="text-muted-foreground leading-relaxed">{REPORTING_SECTION.body}</p>
        </ScrollReveal>
        <ScrollReveal>
          <LazyDemo minHeight={560}>
            <LazyInteractiveReportPreview />
          </LazyDemo>
        </ScrollReveal>
        <ul className="mx-auto mt-8 grid max-w-4xl gap-3 sm:grid-cols-2">
          {REPORTING_SECTION.bullets.map((b) => (
            <li key={b} className="flex items-start gap-2 text-sm text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /> {b}
            </li>
          ))}
        </ul>
      </FullBleedBand>

      <FullBleedBand className="py-16">
        <ScrollReveal className="mx-auto max-w-3xl text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">{MONTH_SECTION.heading}</h2>
          <p className="text-muted-foreground leading-relaxed">{MONTH_SECTION.body}</p>
          <p className="mt-3 text-sm text-muted-foreground">Try the Month selector in the dashboard preview at the top of this page.</p>
        </ScrollReveal>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <div className="grid gap-10 lg:grid-cols-2">
          <ScrollReveal variant="fade-up">
            <CopyBlock heading={BALANCE_SECTION.heading} body={BALANCE_SECTION.body} />
            <div className="mt-6">
              <LazyDemo minHeight={330}>
                <LazyInteractiveBalanceTransfer />
              </LazyDemo>
            </div>
          </ScrollReveal>
          <ScrollReveal variant="fade-up" delay={0.1}>
            <CopyBlock heading={TEAMS_SECTION.heading} body={TEAMS_SECTION.body} />
            <div className="mt-6">
              <LazyDemo minHeight={330}>
                <LazyInteractiveTeamPreview />
              </LazyDemo>
            </div>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-16 border-t border-border/50">
        <div className="mx-auto max-w-3xl space-y-6 text-muted-foreground leading-relaxed">
          <h2 className="text-2xl font-bold text-foreground">What PesoWise is</h2>
          <p>
            PesoWise is operations expense management software for organizations that run on projects, sites and
            distributed teams. It replaces spreadsheets and chat threads with one workflow: capture spend with
            category-specific fields, route it through your configurable approval hierarchy, keep employee balances
            clear, and give finance reports it can rely on at month-end.
          </p>
          <h2 className="pt-2 text-2xl font-bold text-foreground">Who it is for</h2>
          <p>
            Finance managers, operations heads and admin leads who need consistent policy across branches and project
            sites. My Teams gives supervisors visibility without administrator access, and each organization&apos;s
            data stays isolated from every other.
          </p>
          <h2 className="pt-2 text-2xl font-bold text-foreground">Why it matters</h2>
          <p>
            PesoWise captures and governs operational expense activity before finance reconciles or posts it into the
            accounting or ERP system you already use. It complements that system rather than replacing it, so project
            spend, approvals and balances are clear before they reach the ledger.
          </p>
          <p>
            If you are evaluating tools, start with the{" "}
            <Link className="text-primary underline-offset-4 hover:underline" to="/features">
              feature overview
            </Link>{" "}
            and{" "}
            <Link className="text-primary underline-offset-4 hover:underline" to="/contact">
              book a conversation
            </Link>
            . We will map your roles, limits and rollout with you.
          </p>
        </div>
      </FullBleedBand>

      <FullBleedBand variant="soft">
        <ScrollReveal variant="fade-up">
          <Suspense fallback={<div className="h-24" />}>
            <LogoWall />
          </Suspense>
        </ScrollReveal>
      </FullBleedBand>

      {/* Built for teams like yours */}
      <FullBleedBand className="py-20">
        <ScrollReveal className="mb-12 text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">Built for teams like yours</h2>
          <p className="mx-auto max-w-2xl text-muted-foreground">
            PesoWise is configured around your workflow — these are examples of where that fits, not an exhaustive list.
          </p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {USE_CASES.map((uc, i) => {
            const Icon = useCaseIcons[i] ?? Briefcase;
            return (
              <StaggerItem key={uc.title}>
                <div className="card-hover h-full rounded-xl border border-border bg-card p-6 shadow-soft">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10">
                    <Icon className="h-5 w-5 text-accent" aria-hidden />
                  </div>
                  <h3 className="mb-2 text-base font-semibold text-foreground">{uc.title}</h3>
                  <p className="text-sm text-muted-foreground">{uc.description}</p>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="mb-12 text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">How PesoWise Works</h2>
          <p className="text-muted-foreground">From configuration to audit-ready reporting</p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {howItWorksSteps.map((step) => (
            <StaggerItem key={step.step}>
              <div className="card-hover relative h-full rounded-xl border border-border bg-card p-6 shadow-soft">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <step.icon className="h-6 w-6 text-primary" aria-hidden />
                </div>
                <div className="absolute -left-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                  {step.step}
                </div>
                <h3 className="mb-2 text-base font-semibold text-foreground">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.description}</p>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
        <ScrollReveal>
          <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-muted-foreground">
            One example flow — your organization can configure its own stages, reviewers and fields.
          </p>
        </ScrollReveal>
        <ScrollReveal delay={0.3}>
          <div className="mt-4 text-center">
            <Button asChild variant="outline">
              <Link to="/how-it-works">
                Walk through it step by step
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </ScrollReveal>
      </FullBleedBand>

      <FullBleedBand className="py-20">
        <ScrollReveal className="mb-12 text-center">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">Why PesoWise?</h2>
          <p className="text-muted-foreground">Built for teams that need operational clarity, not another generic expense form</p>
        </ScrollReveal>
        <StaggerContainer className="grid gap-8 md:grid-cols-3">
          {whyPesoWise.map((item) => (
            <StaggerItem key={item.title}>
              <div className="card-hover h-full rounded-xl border border-border bg-card p-8 text-center shadow-soft">
                <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                  <item.icon className="h-8 w-8 text-primary" aria-hidden />
                </div>
                <h3 className="mb-3 text-lg font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground">{item.description}</p>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </FullBleedBand>

      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="mx-auto max-w-3xl">
          <h2 className="mb-4 text-center text-2xl font-bold text-foreground md:text-3xl">Frequently asked questions</h2>
          <p className="mb-10 text-center text-sm text-muted-foreground">
            Direct answers for teams researching expense management software.
          </p>
          <FAQAccordion items={HOME_FAQ_ITEMS} />
        </ScrollReveal>
      </FullBleedBand>

      <FullBleedBand variant="soft">
        <ScrollReveal>
          <Suspense fallback={<div className="min-h-[200px]" />}>
            <Testimonials />
          </Suspense>
        </ScrollReveal>
      </FullBleedBand>

      <FullBleedBand className="py-20">
        <ScrollReveal variant="scale">
          <Suspense fallback={<div className="min-h-[120px]" />}>
            <CTASection />
          </Suspense>
        </ScrollReveal>
      </FullBleedBand>
    </MarketingShell>
  );
};

export default HomePage;
