import { Link, useNavigate } from "react-router-dom";
import { MarketingShell, FullBleedBand } from "@/components/marketing";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";

const LAST_UPDATED = "2026-07-13";

export default function DataRightsAndGrievance() {
  const navigate = useNavigate();
  return (
    <MarketingShell>
      <SEOHead
        title="Data Rights & Grievance | PesoWise"
        description="How to exercise your data rights (access, correction, deletion) and how to raise a grievance about data processing on PesoWise."
        canonicalUrl={absoluteUrl("/legal/data-rights")}
        ogImage={DEFAULT_OG_IMAGE}
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
            Data Rights &amp; Grievance
          </h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-12 sm:py-20">
        <article className="mx-auto max-w-4xl space-y-8 leading-relaxed text-muted-foreground">

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <strong>Template notice:</strong> This document is a template and must be reviewed
            by qualified legal counsel before production or public use. It does not constitute
            legal advice. DPDP compliance controls are implemented; legal review is required
            before representing this as compliant. Fill in all placeholder sections marked
            [fill in] before publishing.
          </div>

          <p className="text-foreground">
            This page explains your rights in relation to personal data processed through
            PesoWise and how to submit a request or raise a grievance. The exact rights
            available to you depend on applicable data protection law in your jurisdiction and
            your organisation's policies.
          </p>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">1. Who is responsible for your data?</h2>
            <p className="mb-2">
              <strong>Your organisation</strong> (your employer or the entity that gave you
              access to PesoWise) is the primary data controller / data fiduciary for the
              personal data processed in connection with your use of PesoWise. Your
              organisation is responsible for determining why your data is processed, for how
              long, and what rights you have.
            </p>
            <p>
              <strong>PesoWise (Unimisk)</strong> provides the technical platform and processes
              data on behalf of your organisation. For platform-level queries (e.g. a security
              incident, or a sub-processor question), contact us at{" "}
              <a href="mailto:info@unimisk.com" className="text-primary underline hover:no-underline">
                info@unimisk.com
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">2. Your rights</h2>
            <p className="mb-3">
              Subject to applicable law and your organisation's policies, you may have the
              following rights:
            </p>

            <div className="space-y-4">
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to access</h3>
                <p className="text-sm">
                  Request a copy of the personal data held about you, including any activity
                  insights data if that feature is enabled by your organisation.
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to correction</h3>
                <p className="text-sm">
                  Request correction of inaccurate personal data. For example, if your name or
                  email in PesoWise is wrong, contact your organisation administrator.
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to erasure / deletion</h3>
                <p className="text-sm">
                  Request deletion of your personal data, subject to any legal or contractual
                  obligations your organisation has to retain it (e.g. financial records). For
                  activity insights data specifically, deletion requests are processed by your
                  organisation administrator using provided tooling.
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to object / withdraw consent</h3>
                <p className="text-sm">
                  Where processing is based on your consent or a legitimate interest, you may
                  object. Contact your organisation administrator or raise a grievance (Section 4).
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to data portability</h3>
                <p className="text-sm">
                  Where applicable under law, you may request your data in a structured,
                  machine-readable format. For activity insights data, contact your organisation
                  administrator.
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <h3 className="mb-1 font-semibold text-foreground">Right to nominate</h3>
                <p className="text-sm">
                  Under certain laws (e.g. DPDP Act 2023), you may nominate another individual
                  to exercise these rights on your behalf in the event of your incapacity or
                  death. Contact your organisation to set this up.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">3. How to submit a rights request</h2>

            <div className="space-y-4">
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Step 1 — Contact your organisation administrator</h3>
                <p className="text-sm">
                  Your organisation administrator has access to PesoWise's data export and
                  deletion tooling. For most requests (access, correction, deletion of activity
                  data), this is the fastest route.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Step 2 — Contact PesoWise (Unimisk)</h3>
                <p className="text-sm">
                  If your organisation cannot or does not resolve your request, or if your
                  request relates to platform-level data handling, contact us:
                </p>
                <ul className="mt-2 list-disc pl-5 text-sm">
                  <li>
                    Email:{" "}
                    <a href="mailto:info@unimisk.com" className="text-primary underline hover:no-underline">
                      info@unimisk.com
                    </a>
                  </li>
                  <li>Subject line: <em>Data Rights Request — [your name]</em></li>
                  <li>Include: your name, email on your PesoWise account, the nature of your request, and the organisation you are part of</li>
                </ul>
              </div>
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Response timeline</h3>
                <p className="text-sm">
                  We aim to acknowledge requests within 72 hours and resolve them within 30
                  days (or as required by applicable law). Complex or high-volume requests may
                  take longer — we will inform you if an extension is needed.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">4. Grievance mechanism</h2>
            <p className="mb-3">
              If you believe your personal data has been processed in violation of applicable
              data protection law, or if you are unhappy with how a rights request was handled,
              you may raise a grievance:
            </p>

            <div className="space-y-4">
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Raise a grievance with PesoWise</h3>
                <ul className="list-disc pl-5 text-sm">
                  <li>
                    Email:{" "}
                    <a href="mailto:info@unimisk.com" className="text-primary underline hover:no-underline">
                      info@unimisk.com
                    </a>
                  </li>
                  <li>Subject line: <em>Data Grievance — [your name]</em></li>
                  <li>Describe: the specific concern, what data is involved, and what outcome you are seeking</li>
                </ul>
                <p className="mt-2 text-sm">
                  We aim to acknowledge grievances within 48 hours and provide a resolution
                  or update within 30 days.
                </p>
              </div>
              <div>
                <h3 className="mb-1 font-semibold text-foreground">Escalate to a supervisory authority</h3>
                <p className="text-sm">
                  If you are not satisfied with our response, you may escalate to the relevant
                  data protection supervisory authority in your jurisdiction. In India, this
                  would be the Data Protection Board of India once operational. In other
                  jurisdictions, contact the relevant authority.
                </p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">5. Activity Insights data — specific process</h2>
            <p className="mb-2">
              For requests specifically about{" "}
              <Link to="/legal/activity-insights" className="text-primary underline hover:no-underline">
                User Activity Insights
              </Link>{" "}
              data:
            </p>
            <ul className="space-y-1 list-disc pl-5 text-sm">
              <li>Access requests: your organisation admin can export your activity data</li>
              <li>Deletion requests: your organisation admin can run the activity data erasure tool for your record</li>
              <li>The erasure tool requires explicit admin confirmation before running — it is not automatic</li>
              <li>If your organisation does not act within a reasonable timeframe, escalate to PesoWise using the contact above</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">6. Verification</h2>
            <p className="text-sm">
              To protect your privacy, we may ask you to verify your identity before
              processing a rights request or grievance. We will only use your verification
              data to confirm your identity and will not retain it beyond what is necessary
              for that purpose.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">7. Legal review required</h2>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              This page is a template. DPDP compliance controls are implemented in the platform;
              legal review is required before representing this as compliant or before publishing
              it as your organisation's formal grievance mechanism. Confirm response timelines,
              authority contacts, and data fiduciary roles with your legal counsel.
            </div>
          </section>

          <div className="flex flex-wrap gap-4 pt-4 text-sm">
            <Link to="/privacy" className="text-primary underline hover:no-underline">Privacy Policy</Link>
            <Link to="/toc" className="text-primary underline hover:no-underline">Terms of Use</Link>
            <Link to="/legal/activity-insights" className="text-primary underline hover:no-underline">Activity Insights Notice</Link>
            <Link to="/legal/data-processing" className="text-primary underline hover:no-underline">Data Processing Policy</Link>
            <Link to="/" className="text-primary underline hover:no-underline">Back to home</Link>
          </div>
        </article>
      </FullBleedBand>
    </MarketingShell>
  );
}
