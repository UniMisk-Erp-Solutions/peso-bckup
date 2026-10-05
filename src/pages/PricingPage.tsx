import { Link } from "react-router-dom";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema, faqPageSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { FAQAccordion } from "@/components/marketing/sections";
import { PricingIllustration, MockCompareTable } from "@/components/marketing/pricing";
import { Button } from "@/components/ui/button";
import { Check, Star, ArrowRight, Layers, Settings2, Wrench } from "lucide-react";
import {
  CTA_PRICING,
  PRICING_FACTORS,
  PRICING_HERO,
  PRICING_META_DESCRIPTION,
  PRICING_PLANS,
  PRICING_REQUIREMENTS_PROMPT,
  PRICING_TIERS,
  pricingFaqItems,
} from "@/lib/marketingCopy";

const plans = [...PRICING_PLANS];
const tierIcons = [Layers, Settings2, Wrench];

export default function PricingPage() {
  return (
    <MarketingShell>
      <SEOHead
        title="Plans & pricing | PesoWise"
        description={PRICING_META_DESCRIPTION}
        canonicalUrl={absoluteUrl("/pricing")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Pricing", path: "/pricing" },
          ]),
          faqPageSchema(pricingFaqItems),
        ]}
      />
      {/* Hero */}
      <FullBleedBand variant="hero" className="py-20">
        <ScrollReveal className="text-center">
          <h1 className="mb-6 text-4xl font-bold leading-tight text-foreground md:text-5xl">
            {PRICING_HERO.heading}
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-8">{PRICING_HERO.body}</p>
          <div className="flex justify-center">
            <PricingIllustration className="h-24 w-auto" />
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* Platform / Organization Setup / Additional Requirements */}
      <FullBleedBand className="py-16">
        <StaggerContainer className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-3">
          {PRICING_TIERS.map((tier, i) => {
            const Icon = tierIcons[i] ?? Layers;
            return (
              <StaggerItem key={tier.id}>
                <div className="h-full rounded-xl border border-border bg-card p-6 shadow-soft">
                  <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" aria-hidden />
                  </div>
                  <h3 className="mb-2 text-base font-semibold text-foreground">{tier.title}</h3>
                  <p className="text-sm text-muted-foreground">{tier.description}</p>
                </div>
              </StaggerItem>
            );
          })}
        </StaggerContainer>
        <ScrollReveal>
          <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-primary/30 bg-primary/5 p-6 text-center">
            <p className="text-sm text-foreground">{PRICING_REQUIREMENTS_PROMPT}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              Pricing factors may include: {PRICING_FACTORS.join(", ").toLowerCase()}.
            </p>
            <Button asChild className="mt-4 btn-glow">
              <Link to="/contact">
                {CTA_PRICING}
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* Pricing Cards */}
      <FullBleedBand className="py-20">
        <StaggerContainer className="grid gap-8 lg:grid-cols-3">
          {plans.map((plan, i) => (
            <StaggerItem key={i}>
              <div
                className={`relative rounded-2xl border bg-card p-8 card-hover h-full flex flex-col ${
                  plan.popular ? "border-primary shadow-glow" : "border-border shadow-soft"
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary px-4 py-1 text-sm font-medium text-primary-foreground">
                      <Star className="h-3 w-3 fill-current" />
                      Most Popular
                    </span>
                  </div>
                )}
                <div className="mb-6">
                  <h3 className="text-xl font-bold text-foreground">{plan.name}</h3>
                  <p className="text-sm text-muted-foreground">{plan.description}</p>
                </div>
                <div className="mb-6">
                  <span className="text-3xl font-bold text-foreground">{plan.price}</span>
                </div>
                <ul className="mb-8 space-y-3 flex-grow">
                  {plan.features.map((feature, j) => (
                    <li key={j} className="flex items-start gap-3">
                      <Check
                        className={`h-5 w-5 flex-shrink-0 ${
                          plan.popular ? "text-primary" : "text-accent"
                        }`}
                      />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  asChild
                  variant={plan.popular ? "default" : "outline"}
                  className={plan.popular ? "btn-glow w-full" : "w-full"}
                >
                  <Link to="/contact">
                    {plan.cta}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </StaggerItem>
          ))}
        </StaggerContainer>
      </FullBleedBand>

      {/* Compare Plans */}
      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Compare Plans
          </h2>
          <p className="text-muted-foreground">See all features side by side. Plan details are confirmed in your quote.</p>
        </ScrollReveal>
        <ScrollReveal delay={0.1}>
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0" style={{ WebkitOverflowScrolling: "touch" }}>
            <MockCompareTable />
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* FAQ */}
      <FullBleedBand className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="mb-4 text-2xl font-bold text-foreground md:text-3xl">
            Pricing FAQs
          </h2>
        </ScrollReveal>
        <ScrollReveal delay={0.1}>
          <div className="max-w-3xl mx-auto">
            <FAQAccordion items={pricingFaqItems} />
          </div>
        </ScrollReveal>
      </FullBleedBand>

      {/* Sticky CTA (desktop only) */}
      <div className="hidden lg:block fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-7xl px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <span className="text-sm font-medium text-foreground">Need a tailored plan?</span>
              <span className="ml-2 text-sm text-muted-foreground">
                Let&apos;s discuss your requirements.
              </span>
            </div>
            <Button asChild>
              <Link to="/contact">
                {CTA_PRICING}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* Spacer (desktop only) */}
      <div className="hidden lg:block h-20" aria-hidden />
    </MarketingShell>
  );
}
