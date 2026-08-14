import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, BUSINESS, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand, ScrollReveal } from "@/components/marketing";
import { ContactIllustration } from "@/components/marketing/contact";
import { DemoMotionPanel } from "@/components/marketing/mocks";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  Mail,
  MessageSquare,
  MapPin,
  CheckCircle2,
  Send,
  Phone,
} from "lucide-react";

const CONSENT_VERSION = 1;

/* text-base on mobile prevents iOS zoom on focus; sm:text-sm for compact desktop */
const inputClass =
  "w-full rounded-lg border border-border bg-background px-4 py-2.5 text-base sm:text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary touch-manipulation";
const labelClass = "mb-2 block text-sm font-medium text-foreground";

const benefits = [
  "Guided setup and onboarding",
  "Custom workflow configuration",
  "Team training sessions",
  "Dedicated support contact",
  "Data migration assistance",
];

export default function ContactPage() {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [consentPrivacy, setConsentPrivacy] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!consentPrivacy) {
      toast({
        variant: "destructive",
        title: "Consent required",
        description: "Please agree to the Privacy Policy to submit the form.",
      });
      return;
    }
    setIsSubmitting(true);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const payload = {
      full_name: String(fd.get("fullName") ?? "").trim(),
      work_email: String(fd.get("workEmail") ?? "").trim(),
      company: String(fd.get("company") ?? "").trim(),
      phone: String(fd.get("phone") ?? "").trim(),
      role: String(fd.get("role") ?? "").trim() || null,
      team_size: String(fd.get("teamSize") ?? "").trim() || null,
      multi_level: fd.get("multiLevel") === "on",
      balance: fd.get("balance") === "on",
      multi_location: fd.get("multiLocation") === "on",
      receipts: fd.get("receipts") === "on",
      message: String(fd.get("message") ?? "").trim() || null,
      consent_privacy: true,
      consent_marketing: consentMarketing,
      consent_timestamp: new Date().toISOString(),
      consent_version: CONSENT_VERSION,
    };
    try {
      const { error } = await supabase.from("contact_leads").insert(payload);
      if (error) throw error;

      try {
        await supabase.functions.invoke("send-contact-lead-email", { body: payload });
      } catch (emailError) {
        console.error("Contact notification email failed:", emailError);
      }

      toast({
        title: "Message sent",
        description: "We'll be in touch within 24 hours.",
      });
      form.reset();
      setConsentPrivacy(false);
      setConsentMarketing(false);
    } catch (err: unknown) {
      console.error("Contact form error:", err);
      toast({
        variant: "destructive",
        title: "Could not send",
        description: `Please try again or email ${BUSINESS.contactEmail} directly.`,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <MarketingShell>
      <SEOHead
        title="Contact & demo requests | PesoWise"
        description="Reach PesoWise by Unimisk for demos, onboarding, and support. Share your workflow needs—approvals, ERP integration, and multi-location finance."
        canonicalUrl={absoluteUrl("/contact")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Contact", path: "/contact" },
        ])}
      />
      {/* Hero */}
      <FullBleedBand variant="hero" className="py-12 sm:py-20">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <ScrollReveal variant="fade-up">
            <h1 className="mb-6 text-4xl font-bold leading-tight text-foreground md:text-5xl">
              Get started with PesoWise
            </h1>
            <p className="text-lg text-muted-foreground">
              Tell us about your organization. We'll set up the right workflow and get you live quickly.
            </p>
          </ScrollReveal>
          <ScrollReveal variant="fade-left" delay={0.2}>
            <div className="relative flex items-center justify-center overflow-hidden min-w-0">
              <ContactIllustration className="h-40 sm:h-48 w-auto max-w-full" />
              <div className="absolute bottom-0 right-0 max-w-[200px] sm:-bottom-4">
                <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
                  <div className="space-y-3">
                    <a href={`mailto:${BUSINESS.contactEmail}`} className="flex items-center gap-3 hover:opacity-90">
                      <Mail className="h-4 w-4 text-primary" />
                      <span className="text-xs text-primary underline-offset-2 hover:underline">{BUSINESS.contactEmail}</span>
                    </a>
                    <div className="flex items-center gap-3">
                      <MessageSquare className="h-4 w-4 text-accent" />
                      <span className="text-xs text-muted-foreground">WhatsApp Support</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <MapPin className="h-4 w-4 text-warning" />
                      <span className="text-xs text-muted-foreground">India · teams worldwide</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </FullBleedBand>

      {/* Contact Form Section */}
      <FullBleedBand className="py-12 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-2">
          {/* Form Card (Left) */}
          <ScrollReveal variant="fade-right">
            <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-soft min-w-0">
              <h2 className="mb-6 text-xl font-bold text-foreground">
                Tell us about your organization
              </h2>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="fullName" className={labelClass}>
                      Full Name
                    </label>
                    <input
                      id="fullName"
                      name="fullName"
                      type="text"
                      placeholder="Priya Sharma"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="workEmail" className={labelClass}>
                      Work Email
                    </label>
                    <input
                      id="workEmail"
                      name="workEmail"
                      type="email"
                      placeholder="priya@company.com"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="company" className={labelClass}>
                      Company
                    </label>
                    <input
                      id="company"
                      name="company"
                      type="text"
                      placeholder="ABC Corporation"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label htmlFor="phone" className={labelClass}>
                      Phone / WhatsApp
                    </label>
                    <input
                      id="phone"
                      name="phone"
                      type="tel"
                      placeholder="+91 98765 43210"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="role" className={labelClass}>
                      Your Role
                    </label>
                    <select id="role" name="role" className={inputClass}>
                      <option value="">Select role...</option>
                      <option value="finance">Finance / Accounting</option>
                      <option value="operations">Operations</option>
                      <option value="admin">Administration</option>
                      <option value="management">Management</option>
                      <option value="it">IT / Technical</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="teamSize" className={labelClass}>
                      Team Size
                    </label>
                    <select id="teamSize" name="teamSize" className={inputClass}>
                      <option value="">Select size...</option>
                      <option value="1-5">1-5 employees</option>
                      <option value="6-15">6-15 employees</option>
                      <option value="16-50">16-50 employees</option>
                      <option value="51-100">51-100 employees</option>
                      <option value="100+">100+ employees</option>
                    </select>
                  </div>
                </div>
                <div>
                  <span className="mb-3 block text-sm font-medium text-foreground">
                    Workflow Needs
                  </span>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                      <input
                        type="checkbox"
                        name="multiLevel"
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-muted-foreground">Multi-level approvals</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                      <input
                        type="checkbox"
                        name="balance"
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-muted-foreground">Balance management</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                      <input
                        type="checkbox"
                        name="multiLocation"
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-muted-foreground">Multi-location/branch</span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                      <input
                        type="checkbox"
                        name="receipts"
                        className="rounded border-border text-primary focus:ring-primary"
                      />
                      <span className="text-sm text-muted-foreground">Receipt uploads required</span>
                    </label>
                  </div>
                </div>
                <div>
                  <label htmlFor="message" className={labelClass}>
                    Message (optional)
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    rows={4}
                    placeholder="Tell us more about your expense management needs..."
                    className={`${inputClass} resize-none`}
                  />
                </div>
                <div className="space-y-4">
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                    <input
                      type="checkbox"
                      required
                      checked={consentPrivacy}
                      onChange={(e) => setConsentPrivacy(e.target.checked)}
                      className="mt-0.5 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="text-sm text-muted-foreground">
                      I agree to the{" "}
                      <Link to="/privacy" className="text-primary underline hover:no-underline">
                        Privacy Policy
                      </Link>{" "}
                      and consent to PesoWise processing my information to respond to my request.
                      I have read the{" "}
                      <Link to="/toc" className="text-primary underline hover:no-underline">
                        Terms &amp; Conditions
                      </Link>
                      .
                    </span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={consentMarketing}
                      onChange={(e) => setConsentMarketing(e.target.checked)}
                      className="mt-0.5 rounded border-border text-primary focus:ring-primary"
                    />
                    <span className="text-sm text-muted-foreground">
                      I agree to receive product updates and marketing communication. (optional)
                    </span>
                  </label>
                </div>
                <p className="text-xs text-muted-foreground">
                  We&apos;ll use your details only to contact you about PesoWise. You can request
                  deletion anytime.
                </p>
                <Button
                  type="submit"
                  size="lg"
                  className="w-full btn-glow"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "Sending..." : "Send Message"}
                  {!isSubmitting && <Send className="ml-2 h-4 w-4" />}
                </Button>
              </form>
            </div>
          </ScrollReveal>

          {/* Right Column */}
          <div className="space-y-8">
            <ScrollReveal variant="fade-left" delay={1}>
              <div className="rounded-2xl border border-border bg-card p-8 shadow-soft">
                <h3 className="mb-6 text-lg font-semibold text-foreground">What you'll get</h3>
                <ul className="space-y-4">
                  {benefits.map((benefit, i) => (
                    <li key={i} className="flex items-center gap-3">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10">
                        <CheckCircle2 className="h-4 w-4 text-accent" />
                      </div>
                      <span className="text-sm text-muted-foreground">{benefit}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </ScrollReveal>
            <ScrollReveal variant="fade-left" delay={2}>
              <DemoMotionPanel />
            </ScrollReveal>
            <ScrollReveal variant="fade-left" delay={3}>
              <div className="rounded-xl border border-border bg-muted/30 p-6">
                <h4 className="mb-4 text-sm font-medium text-foreground">
                  Other ways to reach us
                </h4>
                <div className="space-y-3">
                  <a
                    href={`mailto:${BUSINESS.contactEmail}`}
                    className="flex items-center gap-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <Mail className="h-4 w-4 text-primary" />
                    {BUSINESS.contactEmail}
                  </a>
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <MessageSquare className="h-4 w-4 text-accent" />
                    WhatsApp available during business hours
                  </div>
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </FullBleedBand>

      {/* Contact Options (three cards: Email, Phone/WhatsApp, Location) */}
      <FullBleedBand variant="soft" className="py-20">
        <ScrollReveal className="text-center mb-12">
          <h2 className="text-3xl font-bold text-foreground">
            Contact Options
          </h2>
        </ScrollReveal>
        <div className="grid gap-8 sm:grid-cols-3">
          <ScrollReveal variant="fade-up" delay={0}>
            <div className="rounded-2xl border border-border bg-card p-8 shadow-soft text-center">
              <Mail className="h-10 w-10 text-primary mx-auto mb-4" />
              <h3 className="font-bold text-foreground mb-3">Email</h3>
              <a
                href={`mailto:${BUSINESS.contactEmail}`}
                className="text-sm text-primary hover:underline"
              >
                {BUSINESS.contactEmail}
              </a>
            </div>
          </ScrollReveal>
          <ScrollReveal variant="fade-up" delay={1}>
            <div className="rounded-2xl border border-border bg-card p-8 shadow-soft text-center">
              <Phone className="h-10 w-10 text-primary mx-auto mb-4" />
              <h3 className="font-bold text-foreground mb-3">Phone / WhatsApp</h3>
              <div className="text-sm text-muted-foreground space-y-2">
                {BUSINESS.phoneDisplay.map((phone) => (
                  <p key={phone}>
                    <a
                      href={`tel:${phone.replace(/\s/g, "")}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {phone}
                    </a>
                  </p>
                ))}
              </div>
            </div>
          </ScrollReveal>
          <ScrollReveal variant="fade-up" delay={2}>
            <div className="rounded-2xl border border-border bg-card p-8 shadow-soft text-center">
              <MapPin className="h-10 w-10 text-primary mx-auto mb-4" />
              <h3 className="font-bold text-foreground mb-3">Location</h3>
              <p className="text-sm text-muted-foreground text-left">
                10th Floor, Stratum@Venus Ground, Nr. Janshi
                <br />
                Rani Statue, C-1008, West wing, Nehru Nagar,
                <br />
                Ahmedabad, Gujarat 380015
              </p>
            </div>
          </ScrollReveal>
        </div>
      </FullBleedBand>
    </MarketingShell>
  );
}
