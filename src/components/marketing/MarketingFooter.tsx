import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useConsent } from "@/components/legal/CookieConsentBanner";
import { Button } from "@/components/ui/button";
import { BUSINESS, SOCIAL_URLS } from "@/lib/siteConfig";

const PRODUCT_LINKS = [
  { to: "/", label: "Home" },
  { to: "/features", label: "Features" },
  { to: "/how-it-works", label: "How It Works" },
  { to: "/pricing", label: "Pricing" },
  { to: "/security", label: "Security" },
] as const;

const COMPANY_LINKS = [
  { to: "/contact", label: "Contact" },
  { to: "/contact", label: "Request a demo" },
] as const;

const LEGAL_LINKS = [
  { to: "/privacy", label: "Privacy Policy" },
  { to: "/cookies", label: "Cookie Policy" },
  { to: "/toc", label: "Terms" },
  { to: "/disclaimer", label: "Disclaimer" },
  { to: "/legal/activity-insights", label: "Activity Insights Notice" },
  { to: "/legal/data-processing", label: "Data Processing Policy" },
  { to: "/legal/data-rights", label: "Data Rights & Grievance" },
] as const;

const linkClass =
  "block py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded touch-manipulation";

interface MarketingFooterProps {
  className?: string;
}

export function MarketingFooter({ className }: MarketingFooterProps) {
  const currentYear = new Date().getFullYear();
  const consent = useConsent();

  return (
    <footer className={cn("border-t border-border/50 bg-muted/30", className)} role="contentinfo">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          {/* Brand + NAP */}
          <div className="lg:col-span-2">
            <Link
              to="/"
              className="inline-flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded-lg"
            >
              <img
                src="/HERO.png"
                alt="PesoWise"
                width={140}
                height={40}
                decoding="async"
                loading="lazy"
                className="h-9 w-auto flex-shrink-0 rounded-lg"
              />
              <span className="text-xl font-bold text-foreground">PesoWise</span>
            </Link>
            <p className="mt-4 max-w-md text-sm text-muted-foreground">
              {BUSINESS.displayName} — expense management that works with your ERP: clarity, control,
              and audit-ready records for finance-led teams.
            </p>
            <address className="mt-6 not-italic text-sm text-muted-foreground space-y-2">
              <span className="sr-only">Postal address</span>
              {BUSINESS.addressLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
            <div className="mt-4 flex flex-col gap-2 text-sm">
              <a
                href={`mailto:${BUSINESS.contactEmail}`}
                className="text-primary underline-offset-4 hover:underline"
              >
                {BUSINESS.contactEmail}
              </a>
              <div className="flex flex-col gap-1">
                {BUSINESS.phoneDisplay.map((phone) => (
                  <a
                    key={phone}
                    href={`tel:${phone.replace(/\s/g, "").replace(/^\+/, "+")}`}
                    className="text-primary underline-offset-4 hover:underline w-fit"
                  >
                    {phone}
                  </a>
                ))}
              </div>
            </div>
          </div>

          <div>
            <h2 className="mb-4 text-sm font-semibold text-foreground">Product</h2>
            <ul className="space-y-1">
              {PRODUCT_LINKS.map(({ to, label }) => (
                <li key={to + label}>
                  <Link to={to} className={linkClass}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="mb-4 text-sm font-semibold text-foreground">Company &amp; legal</h2>
            <ul className="space-y-1">
              {COMPANY_LINKS.map(({ to, label }) => (
                <li key={to + label}>
                  <Link to={to} className={linkClass}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="mt-4 space-y-1 border-t border-border/50 pt-4">
              {LEGAL_LINKS.map(({ to, label }) => (
                <li key={to}>
                  <Link to={to} className={linkClass}>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            {consent && (
              <Button
                variant="link"
                className="mt-3 h-auto p-0 text-sm text-muted-foreground hover:text-foreground"
                onClick={consent.openPreferences}
              >
                Cookie preferences
              </Button>
            )}

            <h2 className="mb-3 mt-8 text-sm font-semibold text-foreground">Social</h2>
            <ul className="space-y-2 text-sm">
              <li>
                <a
                  href={SOCIAL_URLS.linkedin}
                  className={linkClass}
                  target="_blank"
                  rel="noopener noreferrer me"
                >
                  LinkedIn
                </a>
              </li>
              <li>
                <a
                  href={SOCIAL_URLS.twitter}
                  className={linkClass}
                  target="_blank"
                  rel="noopener noreferrer me"
                >
                  X (Twitter)
                </a>
              </li>
              {SOCIAL_URLS.instagram ? (
                <li>
                  <a
                    href={SOCIAL_URLS.instagram}
                    className={linkClass}
                    target="_blank"
                    rel="noopener noreferrer me"
                  >
                    Instagram
                  </a>
                </li>
              ) : null}
              {SOCIAL_URLS.youtube ? (
                <li>
                  <a
                    href={SOCIAL_URLS.youtube}
                    className={linkClass}
                    target="_blank"
                    rel="noopener noreferrer me"
                  >
                    YouTube
                  </a>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-border/50 pt-8">
          <p className="text-center text-sm text-muted-foreground">
            © {currentYear} {BUSINESS.displayName}. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  );
}
