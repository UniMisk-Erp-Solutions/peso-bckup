import { Link, useNavigate } from "react-router-dom";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand } from "@/components/marketing";
import { useConsent } from "@/components/legal/CookieConsentBanner";
import { Button } from "@/components/ui/button";

const LAST_UPDATED = "2025-02-04";

export default function CookiePolicyPage() {
  const navigate = useNavigate();
  const consent = useConsent();

  return (
    <MarketingShell>
      <SEOHead
        title="Cookie Policy | PesoWise"
        description="How PesoWise uses cookies and similar technologies on the marketing website, and how to manage preferences."
        canonicalUrl={absoluteUrl("/cookies")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Cookie Policy", path: "/cookies" },
        ])}
      />
      <FullBleedBand variant="hero" className="py-12 sm:py-20">
        <div className="mx-auto max-w-4xl">
          <button
            onClick={() => navigate(-1)}
            className="mb-6 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <span aria-hidden="true">←</span> Back
          </button>
          <h1 className="mb-4 text-3xl font-bold text-foreground md:text-4xl">
            Cookie Policy
          </h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </FullBleedBand>
      <FullBleedBand className="py-12 sm:py-20">
        <article className="mx-auto max-w-4xl space-y-8 leading-relaxed text-muted-foreground">
          <p className="text-foreground">
            This cookie policy explains what cookies are, how we use them on the PesoWise marketing
            site, and how you can manage your preferences.
          </p>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">What are cookies?</h2>
            <p>
              Cookies are small text files stored on your device when you visit a website. They help
              the site remember your preferences, keep you signed in, or understand how the site is
              used.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Categories we use</h2>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                <strong className="text-foreground">Necessary:</strong> Required for the site to
                function (e.g. security, load balancing). These cannot be disabled.
              </li>
              <li>
                <strong className="text-foreground">Analytics:</strong> Help us understand how
                visitors use the site (e.g. page views). We do not run analytics by default until
                you consent.
              </li>
              <li>
                <strong className="text-foreground">Marketing:</strong> Used for relevant offers
                and marketing (e.g. campaigns). Only used if you consent.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Current status</h2>
            <p>
              We do not run analytics or marketing cookies by default. Necessary cookies are always
              in use. You can change your preferences at any time using the button below or via the
              cookie banner when it is shown.
            </p>
            {consent && (
              <Button variant="outline" className="mt-4" onClick={consent.openPreferences}>
                Cookie preferences
              </Button>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">How to manage preferences</h2>
            <p>
              Use “Cookie preferences” in the footer or on this page to open the preference panel and
              turn analytics and marketing cookies on or off. Your choices are stored in your
              browser. You can also block or delete cookies via your browser settings; note that
              blocking necessary cookies may affect site functionality.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Changes</h2>
            <p>
              We may update this policy when we change how we use cookies. The “Last updated” date
              will be revised accordingly.
            </p>
          </section>

          <p className="pt-4">
            <Link to="/" className="text-primary underline hover:no-underline">
              Back to home
            </Link>
          </p>
        </article>
      </FullBleedBand>
    </MarketingShell>
  );
}
