import { Link } from "react-router-dom";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema, faqPageSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import StaggerContainer, { StaggerItem } from "@/components/marketing/StaggerContainer";
import { FAQAccordion } from "@/components/marketing/sections";
import { PricingIllustration, MockCompareTable } from "@/components/marketing/pricing";
import { Button } from "@/components/ui/button";
import { Check, Star, ArrowRight } from "lucide-react";
import type { FAQItem } from "@/components/marketing/sections";
import { PRICING_META_DESCRIPTION, PRICING_PLANS } from "@/lib/marketingCopy";

const plans = [...PRICING_PLANS];
const pricingFaqItems: FAQItem[] = [
  {
    question: "How does pricing work?",
    answer:
      "We offer flexible pricing based on your organization's size and needs. Contact our sales team for a customized quote that fits your requirements.",
  },
  {
    question: "Can I change plans later?",
    answer:
      "Yes, you can upgrade or adjust your plan at any time. Our team will help you transition smoothly as your organization grows.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "We offer a guided demo and pilot program for organizations to experience PesoWise before committing. Contact us to get started.",
  },
  {
    question: "What payment methods do you accept?",
    answer:
      "We accept bank transfers, credit cards, and can accommodate various payment arrangements for enterprise clients.",
  },
  {
    question: "Do you offer discounts for annual billing?",
    answer:
      "Yes, we offer discounts for annual commitments. Contact our sales team to discuss the best option for your organization.",
  },
];

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
            Pricing that scales with your organization
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-8">
            Choose the plan that fits your team. All plans include core expense management features with options to grow.
          </p>
          <div className="flex justify-center">
            <PricingIllustration className="h-24 w-auto" />
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
          <p className="text-muted-foreground">See all features side by side</p>
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
                Contact Sales
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
