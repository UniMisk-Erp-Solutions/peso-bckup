import { Link, useNavigate } from "react-router-dom";
import { MarketingShell, FullBleedBand } from "@/components/marketing";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";

const LAST_UPDATED = "2026-07-13";

export default function UserActivityInsightsNotice() {
  const navigate = useNavigate();
  return (
    <MarketingShell>
      <SEOHead
        title="User Activity Insights Notice | PesoWise"
        description="What PesoWise tracks under User Activity Insights, what it does not track, how data is used, your rights, and how to raise a grievance."
        canonicalUrl={absoluteUrl("/legal/activity-insights")}
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
            User Activity Insights Notice
          </h1>
          <p className="text-sm text-muted-foreground">Last updated: {LAST_UPDATED}</p>
        </div>
      </FullBleedBand>

      <FullBleedBand className="py-12 sm:py-20">
        <article className="mx-auto max-w-4xl space-y-8 leading-relaxed text-muted-foreground">

          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
            <strong>When does this apply to you?</strong> This notice applies only if your
            organisation has enabled the User Activity Insights feature. If it has not been
            enabled, no activity data about you is collected. You will see an in-app notice
            before any tracking begins — you must acknowledge it before tracking starts.
          </div>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">1. What is User Activity Insights?</h2>
            <p>
              User Activity Insights is an optional feature that organisations can enable on
              PesoWise. It provides organisation administrators with aggregate reporting on
              how users engage with the PesoWise platform — specifically how much time users
              spend in the app and basic session and expense-submission counts. It is designed
              to help administrators understand platform adoption and support their teams.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">2. Who enables this feature?</h2>
            <p className="mb-2">
              This feature is <strong>disabled by default</strong> for all organisations. It
              can only be enabled by a PesoWise master administrator at the organisation level.
              Before enabling, the admin must confirm:
            </p>
            <ul className="space-y-1 list-disc pl-5">
              <li>The organisation has informed its users about this tracking</li>
              <li>The organisation has the necessary lawful basis or approval</li>
              <li>A data retention policy is in place</li>
              <li>A contact/grievance process is available for users</li>
            </ul>
            <p className="mt-2">
              Every enable or disable action is logged with the identity of the administrator
              and the confirmation text they provided.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">3. What IS tracked</h2>
            <p className="mb-3">When the feature is enabled and you have acknowledged the in-app notice, the following is recorded about your use of PesoWise:</p>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong>Session start time</strong> — when you open PesoWise in your browser
              </li>
              <li>
                <strong>Last seen time</strong> — the last moment PesoWise detected you as active
              </li>
              <li>
                <strong>Visible app usage duration</strong> — how long PesoWise was in an active,
                visible browser tab during a session (does not count time when the tab is in the background)
              </li>
              <li>
                <strong>Session count</strong> — how many sessions you have had on a given day
              </li>
              <li>
                <strong>Expenses submitted per day</strong> — count of expense submissions, not content
              </li>
              <li>
                <strong>Browser user agent</strong> — your browser type and OS (e.g. "Chrome on Windows"),
                used for compatibility and access analysis only
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">4. What is NOT tracked</h2>
            <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">
              <p className="mb-2 font-semibold">The following are explicitly NOT collected:</p>
              <ul className="space-y-1 list-disc pl-5 text-sm">
                <li>Keystrokes or typed content</li>
                <li>Screenshots or screen recordings</li>
                <li>Mouse movements or click coordinates</li>
                <li>Which specific pages or forms you visited</li>
                <li>The contents of your expense forms or uploaded receipts</li>
                <li>Any activity outside the PesoWise application</li>
                <li>Background tab time (only foreground/visible time counts)</li>
                <li>Location or GPS data</li>
                <li>Camera or microphone access</li>
                <li>Any biometric data</li>
              </ul>
            </div>
            <p className="mt-3">
              This is not a surveillance or productivity-monitoring tool. It records only
              whether you used PesoWise, not what you did within it.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">5. How the data is used</h2>
            <ul className="space-y-1 list-disc pl-5">
              <li>To give your organisation administrators a dashboard showing team engagement with PesoWise</li>
              <li>To help admins identify users who may need support or training</li>
              <li>To assist the organisation in measuring platform adoption</li>
            </ul>
            <p className="mt-2">
              The data is not sold to third parties. It is not used for advertising. It is
              accessible only to administrators of your organisation within PesoWise.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">6. Acknowledgement before tracking</h2>
            <p>
              If your organisation has enabled this feature, you will see an in-app notice the
              first time you use PesoWise after the feature was enabled. <strong>Tracking does
              not begin until you acknowledge this notice.</strong> The notice cannot be
              dismissed without acknowledgement — you must read and confirm it before
              continuing.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">7. Data retention</h2>
            <p>
              Your organisation sets its own retention period for activity insights data
              (recommended maximum: 180 days). After the retention period, data is deleted.
              The organisation is responsible for running periodic cleanup. You may request
              deletion before the retention period ends — see Section 8 below.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">8. Your rights</h2>
            <p className="mb-2">
              Subject to applicable law and your organisation's policies, you may have the
              following rights in respect of your activity insights data:
            </p>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                <strong>Right to access:</strong> You may request a copy of the activity data
                recorded about you.
              </li>
              <li>
                <strong>Right to correction:</strong> If you believe data recorded about you
                is inaccurate, you may request correction.
              </li>
              <li>
                <strong>Right to erasure / deletion:</strong> You may request deletion of your
                activity insights data before the retention period ends.
              </li>
              <li>
                <strong>Right to grievance:</strong> You may raise a grievance about how this
                data is being processed.
              </li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, see{" "}
              <Link to="/legal/data-rights" className="text-primary underline hover:no-underline">
                Data Rights &amp; Grievance
              </Link>{" "}
              or contact your organisation administrator directly.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">9. Organisation's responsibility</h2>
            <p>
              Your organisation — not PesoWise — is the first point of contact for questions
              about why this feature is enabled, how long data is retained, and how to exercise
              your rights. PesoWise provides the technical controls; your organisation is
              responsible for complying with applicable data protection law, obtaining the
              required lawful basis, and informing you of your rights.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">10. Legal review required</h2>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
              This notice is a template. DPDP compliance controls are implemented in the
              platform; legal review is required before representing this as compliant or before
              sharing this notice as your organisation's formal data processing notice. Please
              have it reviewed by qualified legal counsel.
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-semibold text-foreground">11. Contact</h2>
            <p>
              For questions about this notice or the User Activity Insights feature, contact{" "}
              <a href="mailto:info@unimisk.com" className="text-primary underline hover:no-underline">
                info@unimisk.com
              </a>
              . For rights requests, see{" "}
              <Link to="/legal/data-rights" className="text-primary underline hover:no-underline">
                Data Rights &amp; Grievance
              </Link>
              .
            </p>
          </section>

          <div className="flex flex-wrap gap-4 pt-4 text-sm">
            <Link to="/privacy" className="text-primary underline hover:no-underline">Privacy Policy</Link>
            <Link to="/toc" className="text-primary underline hover:no-underline">Terms of Use</Link>
            <Link to="/legal/data-processing" className="text-primary underline hover:no-underline">Data Processing Policy</Link>
            <Link to="/legal/data-rights" className="text-primary underline hover:no-underline">Data Rights &amp; Grievance</Link>
            <Link to="/" className="text-primary underline hover:no-underline">Back to home</Link>
          </div>
        </article>
      </FullBleedBand>
    </MarketingShell>
  );
}
