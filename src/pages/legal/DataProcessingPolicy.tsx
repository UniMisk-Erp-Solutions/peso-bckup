import { Link, useNavigate } from "react-router-dom";
import { MarketingShell, FullBleedBand } from "@/components/marketing";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";

const LAST_UPDATED = "2026-07-13";

export default function DataProcessingPolicy() {
  const navigate = useNavigate();
  return (
    <MarketingShell>
      <SEOHead
        title="Data Processing Policy | PesoWise"
        description="How PesoWise processes organizational data, including activity insights controls and security measures."
        canonicalUrl={absoluteUrl("/legal/data-processing")}
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
            Data Processing Policy
          </h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-12 sm:py-20">
        <article className="mx-auto max-w-4xl space-y-8 leading-relaxed text-muted-foreground">

          {/* Template disclaimer */}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            <strong>Template notice:</strong> This document is a template and must be reviewed by
            qualified legal counsel before production or public use. It does not constitute legal
            advice. DPDP compliance controls are implemented; legal review is required before
            representing this as compliant.
          </div>

          <p className="text-foreground">
            This Data Processing Policy describes how PesoWise ("we", "us", "the platform") processes
            data on behalf of organisations ("you", "the organisation", "the controller") that use
            PesoWise for expense management and related features. The final legal classification of
            roles (controller, processor, co-controller, data fiduciary, etc.) must be reviewed and
            agreed with your legal counsel.
          </p>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">1. Roles and responsibilities</h2>
            <p className="mb-2">
              <strong>PesoWise</strong> provides the technical platform, hosting, and feature set.
              Where PesoWise processes personal data on behalf of an organisation and at the
              organisation's direction, PesoWise may act as a data processor / service provider.
            </p>
            <p className="mb-2">
              <strong>The organisation</strong> that enables PesoWise for its employees and users is
              responsible for determining the lawful basis for processing, informing its data
              subjects, handling access/correction/deletion requests, and ensuring compliance with
              applicable data protection law.
            </p>
            <p className="text-sm text-amber-700 bg-amber-50 rounded p-2">
              Final legal roles must be confirmed by your legal counsel. This document uses
              "organisation" and "platform" as descriptive, not legally binding, terms.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">2. Data categories processed</h2>
            <ul className="space-y-2 list-disc pl-5">
              <li><strong>Account and profile data:</strong> name, email, role, organisation membership</li>
              <li><strong>Expense and receipt data:</strong> expense amounts, categories, receipts, approval history</li>
              <li><strong>Organisational configuration:</strong> feature flags, form fields, approval hierarchies</li>
              <li>
                <strong>Activity insights data</strong> (when enabled by the organisation):
                session start time, last seen time, visible app usage duration, session count,
                expenses submitted per day, browser user agent. See{" "}
                <Link to="/legal/activity-insights" className="text-primary underline hover:no-underline">
                  User Activity Insights Notice
                </Link>.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">3. Processing purposes</h2>
            <ul className="space-y-1 list-disc pl-5">
              <li>Providing expense management and approval workflow services</li>
              <li>Enabling organisation admins to manage their team's expense operations</li>
              <li>Supporting cashier, accountant, and reporting functions</li>
              <li>Activity insights reporting (when enabled; per-org, off by default)</li>
              <li>Platform security, fraud prevention, and service continuity</li>
              <li>Legal compliance and dispute resolution</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">4. Sub-processors</h2>
            <p>
              PesoWise uses the following categories of sub-processors / infrastructure providers
              to deliver the service:
            </p>
            <ul className="mt-2 space-y-1 list-disc pl-5">
              <li>Cloud database and authentication provider (Supabase)</li>
              <li>Cloud hosting and CDN (Vercel)</li>
              <li>Cloud object storage for receipts (Cloudflare R2)</li>
              <li>Email notification service ([Sub-processor name — fill in])</li>
            </ul>
            <p className="mt-2 text-sm">
              A full sub-processor list is available on request. Sub-processors are bound by
              appropriate data processing agreements and security obligations.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">5. Security measures</h2>
            <ul className="space-y-1 list-disc pl-5">
              <li>Encryption in transit (HTTPS / TLS)</li>
              <li>Row-Level Security (RLS) — users can only access their own organisation's data</li>
              <li>SECURITY DEFINER RPCs — all data writes and cross-user reads go through server-side functions</li>
              <li>Feature-flag gating — activity insights off by default, per-org enable by master admin only</li>
              <li>Authentication via Supabase Auth</li>
              <li>Supabase project-level access controls</li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">6. Retention and deletion</h2>
            <p className="mb-2">
              Expense and profile data is retained as long as the organisation's account is active and
              for any legally required period thereafter.
            </p>
            <p className="mb-2">
              Activity insights data (when enabled) is subject to the retention period configured
              by the organisation (recommended: 180 days). The organisation is responsible for
              running periodic retention cleanup using the provided tooling.
            </p>
            <p>
              Account deletion or offboarding of individual users will remove or anonymise their
              personal data in accordance with the platform's deletion tooling and the
              organisation's instructions.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">7. Data subject / data principal requests</h2>
            <p className="mb-2">
              The organisation is the first point of contact for data principal requests (access,
              correction, deletion, grievance). PesoWise provides internal tooling to support
              these requests:
            </p>
            <ul className="space-y-1 list-disc pl-5">
              <li>Access/export tooling for activity data</li>
              <li>Erasure tooling for activity data (requires admin approval before execution)</li>
            </ul>
            <p className="mt-2">
              See{" "}
              <Link to="/legal/data-rights" className="text-primary underline hover:no-underline">
                Data Rights &amp; Grievance
              </Link>{" "}
              for how to submit a request.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">8. Breach support</h2>
            <p>
              In the event of a security incident affecting data processed by PesoWise, we will
              notify the affected organisation without undue delay and provide reasonable support
              for incident investigation. The organisation is responsible for notifying its data
              principals and applicable regulatory authorities in accordance with applicable law
              and within legally required timelines (confirm timelines with legal counsel).
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">9. Activity Insights — special controls</h2>
            <p className="mb-3">
              The User Activity Insights feature has additional compliance controls:
            </p>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong>Feature flag:</strong> Disabled by default. Enabled per-organisation by
                PesoWise master admin only.
              </li>
              <li>
                <strong>Admin confirmation:</strong> The enabling admin must confirm the organisation
                has informed its users, has the necessary approval/lawful basis, a defined retention
                policy, and a grievance/contact process.
              </li>
              <li>
                <strong>User acknowledgement:</strong> Users are shown an in-app notice explaining
                what is tracked and what is not. Tracking does not start until the user
                acknowledges the notice.
              </li>
              <li>
                <strong>No hidden tracking:</strong> The feature is not a background surveillance
                tool. It only records visible PesoWise app time, session metadata, and expense
                counts.
              </li>
              <li>
                <strong>No keystrokes, screenshots, or off-app tracking.</strong> See{" "}
                <Link to="/legal/activity-insights" className="text-primary underline hover:no-underline">
                  User Activity Insights Notice
                </Link>{" "}
                for full details.
              </li>
              <li>
                <strong>Audit log:</strong> Every enable/disable action is recorded with actor
                identity and confirmation text.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">10. Cross-border transfers</h2>
            <p>
              Data may be processed in data centres operated by our infrastructure providers
              which may be located outside your jurisdiction. Where required by applicable law,
              appropriate safeguards (such as standard contractual clauses or adequacy decisions)
              are in place. Please confirm the specific data residency requirements with your
              legal counsel and review the privacy documentation of each sub-processor.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">11. Legal review required</h2>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              This policy is a template. Before using it as a basis for data processing or sharing
              it with data subjects or regulators, it must be reviewed and approved by qualified
              legal counsel. DPDP compliance controls are implemented in the platform; legal review
              is required before representing this as compliant.
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">12. Contact</h2>
            <p>
              For data processing queries, contact{" "}
              <a href="mailto:info@unimisk.com" className="text-primary underline hover:no-underline">
                info@unimisk.com
              </a>
              .
            </p>
          </section>

          <div className="flex flex-wrap gap-4 pt-4 text-sm">
            <Link to="/privacy" className="text-primary underline hover:no-underline">Privacy Policy</Link>
            <Link to="/toc" className="text-primary underline hover:no-underline">Terms of Use</Link>
            <Link to="/legal/activity-insights" className="text-primary underline hover:no-underline">Activity Insights Notice</Link>
            <Link to="/legal/data-rights" className="text-primary underline hover:no-underline">Data Rights &amp; Grievance</Link>
            <Link to="/" className="text-primary underline hover:no-underline">Back to home</Link>
          </div>
        </article>
      </FullBleedBand>
    </MarketingShell>
  );
}
