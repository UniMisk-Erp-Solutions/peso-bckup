import { Link, useNavigate } from "react-router-dom";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema } from "@/lib/schema/jsonLd";
import { MarketingShell, FullBleedBand } from "@/components/marketing";

const LAST_UPDATED = "2025-02-04";

export default function DisclaimerPage() {
  const navigate = useNavigate();
  return (
    <MarketingShell>
      <SEOHead
        title="Legal Disclaimer | PesoWise"
        description="General legal disclaimer for PesoWise marketing content from Unimisk—not financial or legal advice."
        canonicalUrl={absoluteUrl("/disclaimer")}
        ogImage={DEFAULT_OG_IMAGE}
        structuredData={breadcrumbSchema([
          { name: "Home", path: "/" },
          { name: "Disclaimer", path: "/disclaimer" },
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
            Legal Disclaimer
          </h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </FullBleedBand>
      <FullBleedBand className="py-12 sm:py-20">
        <article className="mx-auto max-w-4xl space-y-8 leading-relaxed text-muted-foreground">
          <p className="text-foreground">
            The information on the PesoWise website is for general information purposes only. Please
            read this disclaimer carefully. This is not legal or financial advice.
          </p>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">General information only</h2>
            <p>
              Content on this site (including product descriptions, pricing, and how-it-works
              materials) is provided for general informational and marketing purposes. It does not
              constitute advice tailored to your situation. You should seek independent legal,
              tax, or financial advice before making decisions based on this content.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Not legal or financial advice</h2>
            <p>
              Nothing on this site is intended as legal, tax, accounting, or financial advice.
              PesoWise and Unimisk do not provide such advice through this website. For
              jurisdiction-specific or situation-specific guidance, consult a qualified
              professional.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">No warranties</h2>
            <p>
              We make no representations or warranties of any kind, express or implied, about the
              completeness, accuracy, reliability, or availability of the site or its content. Any
              reliance you place on such information is strictly at your own risk.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">External links</h2>
            <p>
              This site may contain links to third-party websites. We do not control or endorse
              those sites and are not responsible for their content or practices. Your use of
              third-party sites is at your own risk and subject to their terms and policies.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Limitation of liability</h2>
            <p>
              To the fullest extent permitted by law, PesoWise and Unimisk shall not be liable for
              any loss or damage arising from your use of this website or reliance on its content,
              including indirect, incidental, or consequential damages.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Contact</h2>
            <p>
              For questions about this disclaimer, contact us at{" "}
              <a
                href="mailto:info@unimisk.com"
                className="text-primary underline hover:no-underline"
              >
                info@unimisk.com
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">Changes</h2>
            <p>
              We may update this disclaimer from time to time. The “Last updated” date at the top
              will be revised when we do. Your continued use of the site after changes constitutes
              acceptance of the updated disclaimer.
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
