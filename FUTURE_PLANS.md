# PesoWise Future Plans

This file is a parking place for approved ideas that are **not being implemented yet**. It should stay practical enough that a future implementation session can start from here without reconstructing the reasoning from chat history.

---

## 1. Automatic Server Outage Detection + Automatic Maintenance/Outage Mode

**Status:** FUTURE WORK — NOT IMPLEMENTED YET  
**Priority:** High after the current Cloud maintenance control plane has settled in Production  
**Current prerequisite:** The Supabase Cloud maintenance control plane already handles planned/forced maintenance independently of the self-hosted PesoWise backend.

### Goal

Automatically detect when the live/self-hosted PesoWise backend becomes genuinely unreachable or unusable and show users a graceful outage/maintenance-style screen instead of allowing the app to fail through normal login/API flows.

The design should distinguish clearly between:

- **Planned maintenance** — scheduled by an administrator.
- **Forced/manual maintenance** — explicitly enabled by an administrator.
- **Automatic outage** — detected because the self-hosted PesoWise backend is unhealthy.

Automatic outages should not overwrite or masquerade as planned maintenance.

---

## 2. Target Architecture

```text
                          SUPABASE CLOUD
                     maintenance / outage state
                               |
                 +-------------+-------------+
                 |                           |
          Planned maintenance         Automatic outage
          controlled by admin         controlled by watchdog
                 |                           |
                 +-------------+-------------+
                               |
                               v
                        PESOWISE FRONTEND
                               |
                   +-----------+-----------+
                   |                       |
            maintenance active?      local server health?
                   |                       |
                 YES                     FAILED
                   |                       |
                   +-----------+-----------+
                               v
                    Maintenance / outage UI
```

The existing Cloud maintenance control plane remains the source for planned/forced maintenance. A separate health state should be introduced for unexpected backend outages.

---

## 3. Phase 1 — Browser-Side Health Protection

Implement this before adding a global external watchdog.

### Health endpoint

Add a very small public endpoint on the self-hosted PesoWise backend, for example:

```text
/healthz
```

It must be:

- unauthenticated;
- extremely cheap;
- free of customer, employee, expense or financial data;
- safe to call frequently;
- fast and deterministic;
- suitable for both browser health checks and a future external watchdog.

Suggested response shape:

```json
{
  "status": "healthy",
  "database": true,
  "auth": true,
  "api": true,
  "timestamp": "2026-08-16T12:00:00Z"
}
```

The implementation should audit the existing self-hosted architecture first and decide which checks actually prove that PesoWise is usable. A bare HTTP 200 from a web server is not sufficient if the database/auth layer is unavailable.

### Browser gate

Before mounting the normal local-Supabase-dependent app:

```text
Cloud planned/forced maintenance check
              |
         active? -> block
              |
              no
              v
      Local backend health check
              |
        healthy? -> normal app
              |
              no
              v
      temporary outage screen
```

Do **not** declare an outage after one failed request.

Suggested browser behavior:

```text
Health check #1 fails
        |
wait a few seconds
        |
Health check #2 fails
        |
show outage UI
```

While in browser-detected outage state, continue lightweight health checks and restore the normal app only after multiple successful checks.

Suggested V1 recovery rule:

```text
2 consecutive successes -> restore normal app
```

This avoids server flapping causing rapid UI transitions.

### Important limitation

Browser-side detection only happens when a browser is open. It does not create a global outage record when nobody is using PesoWise.

That is why Phase 2 exists.

---

## 4. Phase 2 — Independent Global Watchdog

Add a tiny independent monitor outside the self-hosted server and outside Vercel Functions.

### Preferred option

Use a small **Cloudflare Worker with a Cron Trigger** or an equivalent low-cost independent scheduler.

Do **not** use Vercel Functions for this monitoring path.

Conceptual flow:

```text
Every ~1 minute
      |
      v
Independent watchdog
      |
      v
GET PesoWise /healthz
      |
      v
Evaluate result
      |
      v
Update outage state in Supabase Cloud
```

### Suggested detection thresholds

Do not react to one failure.

Recommended starting policy:

```text
Check interval:          1 minute
Declare outage:          3 consecutive failures
Declare recovery:        2 consecutive successes
```

This gives roughly:

- ~2–3 minutes to confirm a real outage;
- ~1–2 minutes to confirm recovery.

These values should be configurable and can be tuned after observing real Production behavior.

### Why consecutive checks matter

They protect against:

- short network hiccups;
- DNS delays;
- a single bad route between providers;
- backend restarts that recover immediately;
- temporary Cloudflare-to-origin connectivity issues.

---

## 5. Cloud Data Model

Do not overload the existing `force_maintenance` flag.

Add a separate Cloud-side health/outage state, for example:

```text
system_health_status
------------------------------------------------
environment
server_state
last_checked_at
last_healthy_at
consecutive_failures
consecutive_successes
outage_started_at
last_error_class
monitor_source
updated_at
```

Suggested states:

```text
healthy
suspected_outage
outage
recovering
```

The exact schema should be reviewed against the existing Cloud maintenance tables before implementation.

Public frontend access should remain read-only and contain no sensitive infrastructure details.

---

## 6. Resolution Priority

The frontend should resolve system state in this order:

```text
1. Manual force maintenance
2. Active scheduled maintenance
3. Confirmed automatic outage
4. Upcoming maintenance banner
5. Healthy / normal app
```

Manual/scheduled maintenance should take priority over automatic outage state.

### Important rule during planned maintenance

If planned or forced maintenance is already active and the self-hosted server becomes unavailable, the watchdog should treat those health failures as **expected**.

Do not create a second automatic-outage incident for the same planned event.

Otherwise history would incorrectly show both:

```text
Scheduled maintenance
+ Automatic outage
```

for one intentional shutdown.

---

## 7. Automatic Outage History

Extend the private Cloud maintenance history so automatic incidents are also captured.

Potential history kinds:

```text
scheduled
forced
automatic_outage
```

Useful automatic-outage fields:

```text
detected_at
recovered_at
failed_checks_before_trigger
successful_checks_before_recovery
last_error_class
monitor_source
```

History remains visible only to authorized maintenance/history administrators.

Example history UI:

```text
16/08/2026
Scheduled
02:00 PM - 03:30 PM
1h 30m
Completed

15/08/2026
Automatic outage
07:42 PM - 07:49 PM
7m
Server unavailable

14/08/2026
Immediate maintenance
11:14 AM - 11:28 AM
14m
Completed
```

Do not store raw sensitive infrastructure errors in public-facing history/UI.

---

## 8. Outage UI

Reuse the existing polished Cloud maintenance visual language, but make the wording truthful.

### Planned maintenance

Example:

> A quick maintenance break  
> We're making a few improvements.  
> Expected back at 07:00 PM.

### Unexpected outage

Example:

> We're having a little trouble connecting  
> PesoWise is temporarily unavailable. We're checking the system and will bring things back as soon as it's healthy.

The outage screen may show:

```text
Last checked
16/08/2026 • 5:22 PM IST

[ Check again ]
```

Do not expose internal technical errors to normal users.

---

## 9. Recovery / Flapping Protection

Do not reopen PesoWise after one healthy ping.

Example:

```text
OUTAGE ACTIVE

success #1
-> stay in outage

success #2
-> healthy
-> restore PesoWise
```

If Production proves noisy after restarts, increase recovery confirmation to three successful checks.

The state machine should be tested specifically for:

```text
down -> up -> down -> up
```

and must not visibly flap for end users.

---

## 10. Failure of the Watchdog Itself

The watchdog must not become a new single point of failure.

If Cloudflare/monitoring execution fails:

```text
watchdog does not run
-> do not automatically change existing outage state merely because the monitor missed a run
```

The browser-side health gate remains a secondary independent protection for users who open the app.

No external monitoring provider should be able to take an otherwise healthy PesoWise offline because of one missed execution.

---

## 11. Security Requirements

Future implementation must preserve these boundaries:

- no service-role/secret keys in the browser;
- watchdog write credentials stored only in the independent trusted runtime;
- Cloud public client remains read-only;
- no customer/expense/user data in health responses;
- no raw database errors exposed publicly;
- watchdog may update only the specific health/outage control-plane data it needs;
- Production and Preview health state must remain isolated;
- manual maintenance authority remains separate from automated monitor authority where practical.

Consider using a narrowly scoped database RPC or equivalent write contract for the watchdog instead of giving it broad table access.

---

## 12. Future QA / Acceptance Criteria

Before releasing automatic outage detection, prove all of the following.

### Healthy backend

```text
/healthz healthy
-> no outage
-> normal PesoWise
```

### One transient failure

```text
one failed check
-> NO outage
```

### Confirmed outage

```text
3 consecutive watchdog failures
-> Cloud state becomes outage
-> new browser receives outage UI
```

### Recovery

```text
1 success
-> remain outage

2 consecutive successes
-> healthy
-> normal PesoWise restored
```

### Planned maintenance overlap

```text
scheduled maintenance active
+ backend intentionally offline
-> no duplicate automatic-outage history record
```

### Browser-only fallback

```text
watchdog unavailable
+ user opens PesoWise
+ local backend repeatedly unavailable
-> browser still shows graceful outage state
```

### Production/Preview isolation

```text
Preview backend down
-> Production health state unchanged
```

### History

```text
automatic outage starts
-> one history occurrence

outage recovers
-> same occurrence closes
-> duration accurate
```

### No request storm

Health probing must stay bounded and single-flight.

---

## 13. Implementation Order When We Return to This

When this future feature is picked up, do it in this order:

1. Audit current self-hosted backend architecture and existing health/RPC endpoints.
2. Design `/healthz` so it reflects actual PesoWise usability.
3. Implement and test `/healthz` locally without changing maintenance behavior.
4. Add browser-side health protection before local auth/app bootstrap.
5. Add a separate automatic-outage UI state.
6. Extend the Cloud control-plane schema for server health/outage state.
7. Extend private history with `automatic_outage` occurrences.
8. Add a narrowly scoped watchdog write path.
9. Implement the external Cloudflare Worker/Cron monitor.
10. Add consecutive-failure and consecutive-success thresholds.
11. Suppress automatic outage creation while planned/forced maintenance is active.
12. Test browser-only detection.
13. Test global watchdog detection.
14. Test recovery/flapping behavior.
15. Test Preview/Production isolation.
16. Perform controlled Preview outage simulation.
17. Perform a short controlled Production proof only after all Preview gates pass.

---

## 14. Explicit Non-Goals for the First Version

Do not overbuild the first implementation with:

- multi-region active-active health monitoring;
- PagerDuty-style incident management;
- SMS/on-call escalation;
- public status-page product;
- automatic server restart/remediation;
- infrastructure orchestration;
- Vercel Functions;
- complex SLO/SLA analytics.

Those can be considered later if actual operations justify them.

---

## 15. Current Decision Summary

When this work resumes, the intended direction is:

- browser-side health guard first;
- independent external watchdog second;
- Cloudflare Worker/Cron preferred over Vercel compute;
- `/healthz` must represent real backend usability, not merely port availability;
- 1-minute watchdog interval initially;
- 3 consecutive failures to declare outage;
- 2 consecutive successes to recover;
- separate `automatic_outage` state/history from scheduled/forced maintenance;
- scheduled/forced maintenance always takes priority;
- automatic outages should be visible in the private maintenance history;
- the automatic outage screen should reuse the existing maintenance UI language but clearly state that the service is temporarily unavailable rather than pretending it was scheduled maintenance.

**Do not implement this section until the owner explicitly resumes this future work.**

---

# Additional PesoWise Roadmap Items Recovered From Prior Discussions

The items below were discussed previously but are not part of the current maintenance release. Before implementation, re-audit the current repository and database because some underlying capabilities may have evolved since the original discussion.

## 16. Bulk Employee Balance / Fund Allocation Import + Audit Ledger

**Status:** FUTURE WORK — NOT IMPLEMENTED AS A COMPLETE WORKFLOW  
**Priority:** High  
**Reason:** This removes repetitive manual balance allocation work while preserving financial auditability.

### Required operating modes

Treat historical migration and recurring allocations as two different workflows rather than one generic spreadsheet upload.

#### Historical migration

Used when onboarding an organization or importing the opening state from an existing system.

```text
validated historical sheet
-> establishes/imports the intended opening balance state
-> creates a clearly-labelled historical/opening ledger event
```

The implementation must define precise overwrite/snapshot semantics before release. Historical migration must never accidentally behave like a recurring credit and double an employee's funds.

#### Daily / weekly / recurring allocation

Used for normal operations after onboarding.

```text
validated allocation sheet
-> adds approved credits to the live employee balance
-> writes matching immutable ledger entries
```

### Atomicity

The balance update and ledger write must be one server-side transaction. Never implement:

```text
update balance
then
insert history
```

as two independent browser operations.

Preferred model:

```text
import batch
-> validate all rows
-> atomic server-side apply
-> employee balances + ledger remain consistent
```

### Import batch model

Future schema should consider:

```text
balance_import_batches
balance_import_rows
```

Useful batch metadata:

- organization;
- source filename;
- source format/profile;
- import mode (`historical` vs `allocation`);
- submitted by;
- validated at;
- applied at;
- row counts;
- rejected-row count;
- source-file checksum/hash;
- reversal status;
- notes/reason.

### Safety requirements

- validation/preview before mutation;
- duplicate-import protection;
- organization isolation;
- exact employee identity resolution;
- explicit handling for unknown/duplicate employee IDs or emails;
- no partial financial apply if the transaction fails;
- immutable audit ledger;
- reversal/compensating entries instead of deleting financial history;
- admin-only apply in V1;
- full test coverage for historical-vs-recurring semantics.

---

## 17. Company-Specific Spreadsheet Mapping + Permanent Import Archive

**Status:** FUTURE WORK  
**Priority:** High as part of the balance-import workflow

Organizations should not be forced to manually reshape every spreadsheet into a PesoWise-specific format.

### Dynamic mapping

Support organization-specific column mapping such as:

```text
Company column              PesoWise field
------------------------------------------------
EMP CODE                 -> employee_id
Employee Email           -> email
Allocation Amount        -> amount
Allocation Date          -> effective_date
Remarks                   -> note
```

The mapper must be dynamic and saved per organization. Do **not** hard-code one-off company formats into application code.

Possible workflow:

```text
Upload company file
-> detect headers
-> choose/map fields
-> validate sample rows
-> save mapping profile for this organization
-> future files reuse the profile
```

Allow a profile to be reviewed or remapped when the company's export format changes.

### Downloadable starter sheet

Provide a simple prefilled template containing the organization's known employees, including at minimum the fields needed to identify them reliably. The original discussion specifically requested employee names/emails to be pre-populated so the operator only needs to fill in balance/allocation/date information.

### Permanent source archive

Every applied import should retain a private, organization-scoped historical source artifact for audit purposes.

Recommended safeguards:

- immutable/private storage;
- file hash/checksum;
- import batch ID;
- who uploaded/applied it;
- original filename;
- timestamp;
- mapping profile used;
- validation summary;
- ability to download the original source during an audit;
- retention policy defined explicitly rather than ad-hoc deletion.

Do not expose source files to employees unless a later requirement explicitly authorizes that.

---

## 18. Employee-Visible Balance / Allocation History

**Status:** FUTURE WORK / VERIFY CURRENT PARTIAL CAPABILITIES FIRST  
**Priority:** High alongside bulk allocations

Employees should be able to understand **why** their current available balance is what it is, without exposing admin-only financial controls.

The history should distinguish events such as:

```text
Opening balance / historical migration
Allocation / credit
Expense deduction
Approved adjustment
Reversal / correction
Transfer-related movement where applicable
```

Each row should show a human-readable date/time, amount, reason/type, and resulting balance where safe and useful.

Important distinction:

- opening/historical balance is not the same thing as a normal recurring credit;
- corrections should remain auditable rather than rewriting old history;
- employee visibility and admin import capability should remain independently feature-gated if the feature-flag system is still used when this is built.

Before implementation, inspect existing cash/fund-transfer history so the new ledger does not create two competing explanations of the same balance.

---

## 19. Large-Team `/team-reports` Scalability + Claim Verification Reliability

**Status:** DEFERRED ENGINEERING ITEM — RE-VERIFY BEFORE WORK  
**Priority:** High if large organizations still reproduce it

A previous large-team issue was identified around the `/team-reports` Claim Verification List, where database work could hit PostgreSQL `57014` / statement timeout behavior around the existing timeout boundary.

When this is resumed, do not patch the UI timeout first. Reproduce against the current Production-sized dataset and inspect the query plan.

Previously-discussed likely work included:

- indexing aligned to the actual organization/status/time filtering path;
- composite-index review around organization/status/created-time access patterns;
- true server pagination rather than large preloads;
- bounded query scopes;
- avoiding repeated enrichment queries;
- explicit retryable timeout/error UX rather than an indefinite loading state.

Acceptance target:

```text
large team
+ Claim Verification List
+ normal filters/pagination
-> bounded DB time
-> no 57014
-> no request storm
-> truthful retry/error state when backend genuinely fails
```

Do not create an index from this document blindly. Capture `EXPLAIN`/query evidence from the current SQL first.

---

## 20. Analytics / Reports Scalability and Resilience Pass

**Status:** FUTURE ENGINEERING / PRODUCT POLISH  
**Priority:** Medium

Several earlier discussions pointed toward a broader reporting architecture that stays fast as organizations become larger.

Future audit should evaluate:

### Data loading

- true server-side pagination for large analytics tables;
- role-aware scope calculated server-side;
- bounded analytics queries;
- stale-while-revalidate where it improves perceived speed;
- debounced/coalesced realtime invalidation rather than refetching repeatedly;
- cancellation/single-flight for superseded requests.

### Reconciliation

Dashboard KPI totals, visible-table totals, filtered summaries and exported totals should use one explicit reconciliation contract. Avoid situations where separate screens silently calculate the same business metric differently.

Where relevant, record:

```text
visible count
filtered total
financial total
reconciliation status
source/revision used
```

### UX states

Reports should have explicit states for at least:

```text
loading
empty
error/retry
stale-but-visible
loaded
```

Do not turn backend errors into endless skeletons or ambiguous zero values.

### Reusable reporting primitives

If the reporting surface keeps expanding, consolidate repeated components for:

- metrics;
- charts;
- tooltips;
- empty/error states;
- filter controls;
- mobile filter sheet;
- export actions.

Do this only when duplication justifies it; avoid a design-system rewrite for its own sake.

### Cost-control / kill switch

For expensive realtime or analytics features, retain a runtime/feature kill switch so a pathological query pattern can be disabled without taking the entire application offline.

---

## 21. Saved Report Views, Exports and Operational Reporting UX

**Status:** FUTURE PRODUCT ENHANCEMENT — VERIFY CURRENT COVERAGE FIRST  
**Priority:** Medium

Earlier planning included making reports more operational rather than purely visual.

Potential scope:

- save commonly-used filter/sort combinations as named views;
- quickly restore a saved view without rebuilding filters;
- CSV/Excel export that respects the exact active server-side filter scope;
- clear reset/refresh behavior;
- shareable internal report configuration only if permissions are explicit;
- admin-facing audit/report views with date/employee/team/status filters.

Exports must use authoritative server data, not just whichever rows happen to be loaded in the current browser page.

---

## 22. Compliance / Legal UI Completion

**Status:** FUTURE COMPLIANCE CHECK — VERIFY WHAT IS ALREADY LIVE  
**Priority:** High before wider enterprise rollout

A prior PesoWise compliance discussion called for clear application-facing privacy, terms and data-rights surfaces around the DPDP work.

Before building anything, audit what is already implemented. If still missing, consider public/app routes such as:

```text
/legal/privacy
/legal/terms
/legal/data-processing
/legal/activity-insights
/legal/data-rights
```

Expected integration points may include:

- login/footer links;
- admin enablement/notice surfaces where required;
- activity-insights disclosure where the optional feature is enabled;
- grievance/data-rights contact path;
- retention/export/erasure explanations aligned with actual backend behavior.

Legal text must not be invented from code. Final wording requires owner/legal review and real company/contact details before Production publication.

---

## 23. Accounting / ERP Integration Layer

**Status:** EXPLORATORY PRODUCT ROADMAP  
**Priority:** Medium — validate customer demand before building

PesoWise becomes more valuable if approved expense data can move cleanly into the accounting systems customers already use rather than requiring another spreadsheet step.

Previously-discussed candidates include:

- Tally;
- Zoho Books;
- broader accounting/ERP/invoicing export/integration.

Do not begin with multiple deep integrations at once. First design a stable internal export/accounting contract for approved expenses, categories, taxes, employee/vendor identity and references. Then build one connector based on actual customer demand.

Important requirements:

- organization-scoped credentials;
- no secrets in browser storage;
- idempotent posting / duplicate prevention;
- sync status and retry history;
- reversible/manual correction workflow;
- clear mapping between PesoWise categories/fields and the target accounting system;
- export remains available as a fallback even when a connector is unavailable.

---

## 24. India-Specific Expense Capture Enhancements

**Status:** EXPLORATORY  
**Priority:** Medium/Low until customers request them

Previously-noted product gaps worth keeping visible:

### GST-aware expense fields

Potential future support for structured GST information where customer workflows require it. Do not add tax complexity globally if only some organizations need it; make it configurable.

### UPI-specific capture

Consider structured UPI/reference capture only if it improves reconciliation or receipt matching. Avoid storing unnecessary payment details.

### Mileage / travel reimbursement

Possible future mileage workflow:

```text
distance
x organization-approved rate
-> calculated claim amount
```

with organization-specific policy/rate history and auditability.

These are candidates, not committed V1 requirements.

---

## 25. Multi-Currency Expense Support

**Status:** EXPLORATORY — FUTURE INTERNATIONALIZATION  
**Priority:** Medium/Low until a real multi-currency customer requires it

Current future planning should keep room for organizations where employees incur expenses in currencies different from the organization's reporting/base currency.

A correct implementation would need to distinguish:

```text
transaction currency
transaction amount
conversion rate/source
base currency
base amount
conversion timestamp/date
```

Do not simply add a currency symbol dropdown. Approval limits, balances, exports, analytics, reimbursement amounts and audit history all need one consistent conversion contract.

Exchange-rate handling must be deterministic and auditable; never silently recalculate historical approved expenses using today's rate.

---

## 26. Mobile / Tablet Product Strategy

**Status:** EXPLORATORY  
**Priority:** Later

PesoWise should continue to be highly usable on mobile web for employee expense submission, receipt capture and approval tasks.

A dedicated native/mobile app should be considered only when mobile-web limits create a real product problem. Do not create a native app merely for presence in an app store.

Before deciding on native development, measure whether customers need capabilities such as:

- more reliable camera/receipt capture;
- offline draft submission;
- device-level notifications;
- very frequent manager approvals on mobile.

Until then, prioritize responsive/mobile-web quality and a clean filter/action experience on small screens.

---

## 27. Notifications and Workflow Automation

**Status:** FUTURE PRODUCT ENHANCEMENT  
**Priority:** Medium

Earlier product planning included more reliable alerts and workflow automation. Future work should begin with **in-app events and a clear notification contract**, then add external channels only where customers need them.

Potential use cases:

- approval/review action required;
- expense returned/corrected/rejected;
- fund/allocation event completed;
- important operational/report condition;
- scheduled maintenance or service-impact notice where appropriate.

Possible delivery channels later:

- in-app;
- email;
- messaging integration.

Requirements:

- no duplicate notification storm;
- per-organization/user preferences;
- event IDs/idempotency;
- retry without duplicate delivery;
- audit of important operational notifications;
- sensitive expense information minimized in external message bodies.

---

## 28. Roadmap Hygiene Rules

When any item in this file is resumed:

1. Re-audit current `main` before assuming the feature is still missing.
2. Check whether a partial implementation already exists on another branch before starting from scratch.
3. Separate Product requirements from DB/infra implementation details.
4. Use Preview first for migrations and destructive/financial workflows.
5. Preserve organization isolation and financial auditability as non-negotiable requirements.
6. Prefer atomic server-side mutations for anything affecting balances, approvals, audit history or external accounting sync.
7. Add explicit rollback/reversal behavior before Production release.
8. Do not merge speculative roadmap ideas merely because they are documented here.

### Intentionally not duplicated here

Some previously-discussed PesoWise work is already implemented/live or exists as active branch work and therefore should **not** be re-created as a new future feature. Always inspect current `main`, `dev`, Cloud maintenance infrastructure and existing review/import code before using this document as an implementation specification.

---

## 29. Safety, Recovery, Recycle Bin + Universal 10-Second Undo

**Status:** APPROVED FUTURE WORK — DESIGN DECISIONS CAPTURED, NOT IMPLEMENTED YET  
**Priority:** High  
**Complexity:** High / cross-cutting. Treat this as an application safety layer, not a collection of unrelated delete-button patches.

### Product decisions already made

The intended PesoWise behavior is:

- every user-visible state-changing action should produce a proper success toast with an **Undo** action available for approximately 10 seconds where a valid reversal exists;
- the toast should have a visible 10-second countdown/progress timeline rather than disappearing unpredictably;
- routine destructive actions do **not** require users to type `PRODUCTION`, `DELETE`, an entity name, or another confirmation phrase;
- the backend action happens immediately; Undo performs a real server-authoritative inverse/reversal rather than relying on client-only cached state;
- the server, not the browser timer, is authoritative for whether the undo window is still valid;
- every original action and every Undo/reversal remains permanently auditable;
- actual deletable records should use a **15-day Recycle Bin** where appropriate;
- historically referenced configuration/master data should normally be **deactivated, archived or retired**, not physically deleted;
- financial/workflow actions should **not** be put in the Recycle Bin. Their 10-second Undo must be an auditable compensating/reversal action;
- existing permission and business-rule checks remain in force. Adding Undo must not broaden who is allowed to perform the original action or its reversal.

### Core safety model

```text
                         PESOWISE ACTION
                                |
                    server applies action now
                                |
                                v
                     authoritative action event
                                |
                     +----------+----------+
                     |                     |
                 UI toast             audit timeline
              Undo · 10 sec          original event kept
                     |
             user presses Undo?
                 /         \
               YES          NO
                |             |
                v             v
        server-side inverse   action remains
        / compensating event  applied
```

The frontend must never implement this by waiting 10 seconds before actually saving the original action. Closing the tab, changing devices or losing connectivity must not make application state ambiguous.

### Shared action-event / undo contract

Before wiring individual screens, introduce one shared server-side concept for reversible UI actions. Exact names should be chosen after auditing existing audit/event tables, but a future structure may look like:

```text
action_events
------------------------------------------------
id
organization_id
actor_user_id
action_type
entity_type
entity_id
action_batch_id
applied_at
undo_expires_at
undone_at
undo_status
client_request_id / idempotency_key
metadata / minimal reversal metadata
created_at
```

Bulk actions may require child/action-item rows so one UI action can reference multiple affected records without storing a fragile comma-separated list.

Each newly-integrated mutation should return at minimum:

```text
action_id
applied_at
undo_expires_at
undo_available
```

The UI then shows the global Undo toast from that response.

Undo should be idempotent and concurrency-safe. Before reversing, the server must verify:

- the caller is authorized;
- the action belongs to the same organization;
- the Undo window has not expired;
- the action has not already been undone;
- the entity has not entered a conflicting later state;
- any financial/dependent mutation can still be reversed safely.

If another valid action has already changed the same record and exact reversal is unsafe, Undo should fail clearly rather than silently overwriting newer state.

### Global Undo toast UX

Build one reusable application-wide toast rather than custom timers on every page.

Desired behavior:

```text
Expense moved to Recycle Bin          Undo   10s
[===============================>          ]
```

or:

```text
User deactivated                     Undo   10s
```

Requirements:

- visible countdown/progress timeline;
- desktop and mobile parity;
- accessible Undo button;
- clicking Undo immediately disables the button and shows progress;
- success changes the toast to a short `Restored` / `Undone` acknowledgement;
- a failed Undo shows a truthful reason;
- multiple rapid actions must not overwrite each other's undo handles;
- each toast is bound to its own server `action_id`;
- server expiry remains authoritative even if the browser timer drifts.

The action should also remain in the permanent activity/audit timeline after the 10-second toast expires.

### 15-day Recycle Bin

Use the Recycle Bin for records where product semantics genuinely support deletion/recovery. Do not force every archive/deactivation into it.

Potential V1 candidates after a fresh destructive-action inventory:

- deletable expenses under the existing permission/status rules;
- drafts;
- attachments/files where deletion is currently allowed;
- genuinely disposable records/configuration that are not required by historical business records.

Suggested soft-delete metadata:

```text
deleted_at
deleted_by
purge_after
recycle_event_id
```

Conceptual lifecycle:

```text
active
-> soft deleted
-> hidden from normal application queries
-> 10-second Undo available
-> Recycle Bin restore available until 15 days
-> purge only after retention expires and only where permanent deletion is actually allowed
```

A unified Recycle Bin screen should show at least:

```text
item / display label
entity type
deleted by
deleted on
permanent-delete date / remaining days
Restore
```

Restore must be server-side, authorization-checked and auditable.

Do **not** delete immutable audit/history records merely because their parent business record went into the Recycle Bin. Receipt/object deletion must follow the same retention boundary: do not remove a MinIO/Storage object immediately if its parent can still be restored.

Permanent purge should run through a bounded trusted server-side job/RPC after the self-hosted scheduling capabilities are re-audited. Do not rely on an open browser tab for the 15-day purge.

### Historical master data: deactivate/archive/retire instead of delete

Historically referenced master/configuration records should remain available to old records even after they disappear from future-entry screens.

Preferred semantics:

```text
User             -> Deactivate / Reactivate
Category         -> Archive / Restore
Location         -> Archive / Restore
Used team         -> Archive / Restore where historical references exist
Used form template-> Retire / Restore
Dropdown option  -> Retire / Restore
Dependent field  -> Retire / Restore
```

An unused entity with no historical references may later be eligible for the Recycle Bin, but usage/reference checks must be server-authoritative.

### User deactivation contract

The current user-removal flow already behaves more like deactivation and preserves expenses/audit history. Formalize that product behavior and remove misleading `Delete User` terminology.

Required behavior:

```text
Active organization member
-> Deactivate User
-> organization membership becomes inactive
-> user disappears from active-user lists
-> user cannot enter/use that organization
-> user does not count toward organization active-user/seat limit
-> expenses, approvals, transfers, reports and audit history remain intact
-> 10-second Undo can reactivate immediately
-> user remains available in a Deactivated Users view for later Reactivate
```

Do not hard-delete the Auth user merely to remove one organization membership. If multi-organization membership exists, deactivating one organization must not destroy access to another active organization.

Explicitly verify the AuthContext/ProtectedRoute/membership bootstrap path so an inactive membership cannot be used to enter the deactivated organization.

### Form-field dropdown retirement — required historical behavior

For a dropdown template with:

```text
A
B
C
D
```

if existing expenses contain `B` and an administrator removes `B`, the required behavior is:

```text
NEW EXPENSES:
A
C
D

OLD EXPENSES:
B remains stored and displayed exactly as historical data
```

Retiring an option must never rewrite/delete old `expense_form_field_values` merely because the template's current active options changed.

Current architecture already stores the selected literal value on the expense separately from the template's active options; preserve that advantage.

Preferred future product wording is **Retire option** rather than implying historical deletion.

A minimally invasive implementation should keep the existing active `options[]` contract for current form rendering while adding durable retirement metadata, for example a dedicated option-state table or a carefully designed retired-option metadata structure. The exact schema must be selected after auditing all existing `options[]` consumers so two competing sources of truth are not introduced accidentally.

Required metadata should support at least:

```text
option value
template id
retired_at
retired_by
original display order
restored_at / active state
```

Restoring `B` should make it available to new forms again without changing historical expenses.

### Conditional / nested dropdowns are the critical edge case

Current branch persistence already supports retired branch rows. Preserve branch IDs and historical values instead of deleting configuration rows that historical expenses reference.

Example:

```text
Department
├── A
├── B
│   ├── Vehicle Type = Car
│   └── Vehicle Number = GJ01AB1234
├── C
└── D
```

After `B` is retired:

- new expenses cannot choose `B`;
- old expenses continue to show `Department = B`;
- old dependent values such as `Vehicle Type` and `Vehicle Number` remain readable;
- opening an old expense and changing an unrelated field such as amount must **not** silently delete those retired/hidden branch values;
- only an explicit parent selection change away from `B` may intentionally invalidate B-specific branch values according to the defined edit rules.

The existing custom-field save path uses replace semantics for visible branch values, so this historical-edit scenario must receive a deliberate preservation rule and regression tests before release.

One safe direction is:

1. capture the originally persisted template/branch values when loading an expense for edit;
2. track which controlling template/branch values the user actually changed;
3. build the final atomic replacement payload from current visible values **plus original historical hidden/retired values that were not explicitly invalidated**;
4. remove a hidden historical branch value only when an explicit controlling choice change makes it intentionally obsolete;
5. keep the operation atomic through the existing custom-field replacement contract.

### Reports, review and filters

Retired options must remain visible wherever historical expenses are displayed or filtered.

Audit and test:

- Expense Detail;
- Expense edit form;
- Review Expenses;
- Reports;
- Team Reports / Claim Verification where applicable;
- CSV/Excel exports;
- custom-field filter discovery;
- corrections/resubmission flows;
- batch expenses.

A historical value such as `B` may be offered in report filters even though it is no longer selectable on a new expense. If shown in an administrative/editor context, a small `Retired` indicator is acceptable, but historical report/export values themselves should not be rewritten.

### Financial/workflow actions also get the 10-second Undo

These actions are **not** Recycle-Bin actions, but the universal Undo requirement applies to them as well:

- setting/editing/resetting balances;
- approving an expense;
- rejecting an expense;
- manager-override approval;
- bulk approve/reject;
- transfer-offer accept;
- transfer-offer reject;
- transfer-offer cancel;
- bank-account deactivate/reactivate;
- other later financial/workflow state transitions discovered by the destructive-action inventory.

For financial data, Undo must never erase the original audit event. It should create a compensating/reversal event.

Example:

```text
12:30:00 Expense approved
         Balance ₹20,000 -> ₹8,000
         action_id = X

12:30:06 User clicks Undo

12:30:06 Approval reversed
         Balance ₹8,000 -> ₹20,000
         reverses_action_id = X
```

Both events remain visible in history.

Balance changes should reverse through the authoritative balance ledger/history rather than directly overwriting a number without trace.

For transfer acceptance, undo must atomically reverse all balance movements and state changes, and only if no conflicting later action makes reversal unsafe.

For reject/cancel actions, Undo can restore the previous valid workflow state when still safe.

For bulk actions, preserve batch semantics. One UI bulk action should return one parent `action_id` and reverse the same atomic scope that was actually applied; do not partially undo an atomic batch unless the existing business contract explicitly permits partial reversal.

### No typed destructive confirmation in this feature

Do not add routine typed confirmation phrases such as:

```text
PRODUCTION
DELETE EXPENSE
RETIRE B
DEACTIVATE USER
```

The owner prefers the universal 10-second Undo + permanent audit/recovery model rather than repetitive typed confirmations for ordinary application actions.

Existing special-purpose confirmation behavior outside this feature (for example infrastructure/maintenance controls) may remain independent where it already exists and is justified by that subsystem.

### Likely shared frontend additions

Exact paths should be chosen after a current repository audit, but likely new shared modules include equivalents of:

```text
src/contexts/UndoActionContext.tsx
src/hooks/useUndoableAction.ts
src/services/undoableActionService.ts
src/components/UndoActionToast.tsx
src/pages/RecycleBin.tsx
src/components/recycle-bin/*
src/lib/actionTimeline.ts
```

Prefer adapting the existing toast system rather than creating a second unrelated notification stack.

Likely existing areas requiring integration include:

```text
src/pages/Expenses.tsx
src/pages/ExpenseDetail.tsx
src/pages/ExpenseForm.tsx
src/services/ExpenseService.ts
src/pages/UserManagement.tsx
src/pages/CategoryManagement.tsx
src/components/FormFieldTemplateEditorDialog.tsx
src/lib/formBuilder/templateEditor.ts
src/lib/optionBranchPersistence.ts
src/lib/expenseFormFieldPayload.ts
src/components/CategoryFormFieldsSection.tsx
src/components/SearchableSelectField.tsx
src/pages/EngineerReview.tsx
src/pages/Balances.tsx
src/pages/TransferOffers.tsx
bank-account/settings/admin surfaces discovered by audit
src/App.tsx / navigation for Recycle Bin
locales and feature documentation
```

Do not treat this list as exhaustive. Before implementation, perform a mechanical repository/migration inventory of `.delete()`, Storage `.remove()`, archive/deactivate flows, destructive RPCs, `DELETE FROM`, `ON DELETE CASCADE`, balance mutations, approvals, rejections, overrides, transfers and bulk mutations.

### Likely database work

Use additive migrations and matching rollback files. Exact migration names depend on implementation date, but expected concerns include:

- action-event/undo journal;
- soft-delete/recycle metadata for selected entities;
- recycle-bin metadata/view/RPCs;
- form-template option retirement metadata;
- atomic retire/restore option RPCs;
- action-specific reversal/undo RPCs;
- purge job/function after the 15-day window;
- RLS/authorization for action history and Recycle Bin;
- indexes for active (`deleted_at IS NULL`) and recycle/purge queries.

Do not create one giant generic SECURITY DEFINER function with broad authority without carefully scoped authorization. Shared dispatch is acceptable only when each action remains strongly validated and organization-scoped.

### Suggested implementation phases

#### Phase 0 — branch reconciliation + destructive-action inventory

Before coding:

1. re-audit current `main` and `dev`;
2. reconcile current `main` into `dev` safely before beginning this feature;
3. do not merge `dev` into `main` as part of that preparation;
4. inventory every destructive/state-changing frontend action, backend RPC, storage removal and database cascade;
5. classify each as Recycle Bin, deactivate/archive/retire, or compensating Undo;
6. capture the exact current permission/status rules so the feature cannot widen authorization.

#### Phase 1 — shared action event + global 10-second toast

Build and test the server action-event contract and shared frontend Undo toast first. Prove one low-risk action end-to-end before integrating more actions.

#### Phase 2 — master-data retirement/deactivation

Implement/harden:

- User Deactivate/Reactivate;
- category Archive/Restore parity;
- location Archive/Restore;
- team retirement/archive where historical usage exists;
- form-template Retire/Restore;
- dropdown-option Retire/Restore;
- dependent-field retirement.

Prioritize the dropdown/nested-field historical-preservation tests during this phase.

#### Phase 3 — Recycle Bin

Add soft deletion, unified Recycle Bin, restore, 15-day retention metadata and delayed physical file cleanup for eligible entities.

Do not expand current delete permissions/status rules merely because Recycle Bin exists.

#### Phase 4 — financial/workflow Undo

Integrate action-by-action, with independent tests for each reversal contract:

- balances;
- single approval/rejection;
- manager override;
- bulk review actions;
- transfer accept/reject/cancel;
- bank-account state changes;
- other discovered financial/workflow mutations.

Do not implement a frontend-only rollback. Every financial undo must be atomic, auditable and server-authoritative.

#### Phase 5 — complete application integration

Integrate all remaining eligible actions with the shared toast/action timeline and remove one-off inconsistent Undo patterns.

#### Phase 6 — QA + Preview proof + controlled Production rollout

Run full automated tests plus dedicated Preview/manual QA. Production rollout only after Preview proves data preservation, authorization and reversal semantics.

### Required QA scenarios

At minimum automate and manually prove:

#### Universal toast

```text
action succeeds
-> toast appears
-> countdown/progress runs for 10 seconds
-> Undo inside window succeeds
-> Undo after server expiry is rejected truthfully
-> double-click Undo is idempotent
-> multiple rapid actions each retain their own Undo
```

#### Dropdown retirement

```text
Create options A/B/C/D
Create historical expense with B
Retire B
New expense cannot select B
Old expense still displays B
Edit old expense amount only
Save
B is still B
Restore B
New expense can select B again
```

#### Nested dropdown preservation

```text
Historical parent B has dependent values
Retire B
Open old expense
Change unrelated field
Save
Every historical dependent value remains
```

Also test explicit B -> C change and verify only then are intentionally obsolete B-dependent values removed according to the documented rule.

#### User deactivation

```text
deactivate user
-> active membership removed from normal lists
-> seat count decreases
-> organization access blocked
-> historical expenses/audit unchanged
-> Undo within 10 seconds reactivates
-> later Reactivate works from deactivated-user management
```

#### Recycle Bin

```text
delete eligible item
-> disappears from normal view
-> appears in Recycle Bin
-> Undo restores immediately
-> later Restore works before 15 days
-> unauthorized user cannot restore
-> audit history remains
-> associated file remains recoverable during retention
```

#### Financial action reversal

For each integrated financial/workflow action:

```text
apply action
-> authoritative state changes exactly once
-> action event recorded
-> Undo within window
-> compensating state changes exactly once
-> original audit entry remains
-> reversal audit entry references original action
-> balances/totals reconcile
```

Test conflicting-later-action cases so Undo refuses rather than corrupting newer state.

#### Bulk action

```text
bulk action applies N records atomically/as defined
-> one parent action event
-> Undo reverses the same business scope
-> no duplicate balance/audit mutations
```

#### Authorization / RLS

Test cross-organization denial, role denial, inactive-user denial and server-side checks independently of hidden UI buttons.

#### Regression

Run the complete existing suite, typecheck, lint/build and the review/maintenance/auth tests. Specifically verify that the Cloud maintenance control plane and local Supabase auth-storage isolation remain unchanged.

### Complexity / implementation estimate

This is **high complexity (roughly 8/10)** because it crosses form configuration, historical data, user lifecycle, storage, expenses, review workflows, balances and transfers. The toast itself is easy; safe server-authoritative reversals are the difficult part.

A realistic implementation budget for one experienced engineer with AI assistance but proper review is approximately:

```text
Branch sync + full inventory                  0.5–1 day
Shared action journal + Undo toast            1–2 days
Master data + dropdown retirement             2–3 days
Recycle Bin + restore/purge/storage handling  2–3 days
Financial/workflow Undo contracts             3–5 days
Full regression/Preview/manual QA             2–3 days
------------------------------------------------------
Total safe engineering budget                ~10–15 working days
```

The non-financial foundation alone may be achievable in roughly 4–7 working days, but do not compress the complete financial Undo rollout into that estimate. Production proof and debugging can extend the calendar depending on existing RPC/cascade behavior discovered during the audit.

### Current `dev` branch continuation point (captured 17/08/2026)

At the time this roadmap section was added:

```text
dev  = a17f2827af2e7e0b90843404362e619747212b2c
main = 7e9bb82927392bdfe88f253ba28961c7e3fbd451
merge base = bf798862cdd52bc6224de124ff230044831f9aab
```

`dev` was **12 commits ahead and 10 commits behind `main`**.

The latest DEV work is not an unfinished half-built feature. It is a **parked, owner-QA-complete Review Expenses / Manager Override stabilization line**. The last DEV documentation explicitly records:

- one canonical `/review` surface backed by `EngineerReview.tsx`;
- removal of the abandoned debug/server/alternate review surfaces and feature flags;
- preservation of the live `reviewQueueServer` transport used by `EngineerReview`;
- Manager Override fixes at both RLS and RPC authorization layers;
- Production-applied migrations for manager-override direct-employee scope and reporting-chain depth;
- additional review reliability/custom-field tests;
- DEV intentionally **not merged to main**.

Meanwhile `main` moved forward independently with the Cloud maintenance control plane, local-auth storage isolation changes and this `FUTURE_PLANS.md` roadmap.

Therefore the next DEV session should **not** simply start coding this safety feature on `a17f2827...` as-is. First:

```text
preserve/backup current dev ref
-> fetch latest main/dev
-> merge current main INTO dev (do not merge dev into main yet)
-> resolve conflicts deliberately
-> run full suite + maintenance + review regression
-> push the reconciled dev
-> start this safety/recovery work from that reconciled dev tip
```

Because both branches touched application routing/documentation, expect at least `src/App.tsx` / documentation-index review during reconciliation. Do not rebase/force-push the shared `dev` history merely to make the graph linear; preserving the already-reviewed DEV commits and applied-migration history is more important.

**Do not perform the branch reconciliation or implement this section until the owner explicitly starts that work.**
