# Public Website Refresh: Current Product + Interactive Previews

**Doc ID:** DOC-135
**Status:** in progress (on `feature/recent-expense-field-values`, not merged)
**Last updated:** 2026-09-25 (rev 1.0)
**Owner / area:** Public marketing site (Home, Features, How It Works, Pricing, Security)
**Numbering note:** DOC-134 is reserved by the unmerged auth hotfix branch.

## 1) Summary
The public site described an older product. Copy now reflects operations expense management (configurable forms, hierarchy approvals, employee balances, month-aware dashboards, server-generated reports with in-app preview), and the static mock-ups are replaced by **playable React replicas** of the product built on the shared UI primitives with synthetic data. No screenshots, no customer data, no backend calls from any demo.

## 2) Component audit
| Component | Verdict |
|---|---|
| `MockDashboardLarge`, `MockExpenseForm`, `MockExpenseCard`, `MockWorkflowDiagram`, `MockApprovalTimeline`, `MockBalanceTransfer`, `MockAnalyticsDashboard`, `WorkflowLivePanel` | REPLACED by the interactive previews and removed (no remaining references) |
| `MockOrgChart`, `MockAuditLog`, `ReceiptIllustration`, `WorkflowIllustration`, `DemoMotionPanel` (Contact), `MockCompareTable` (labels renamed only), `LogoWall` (wording), `Testimonials`, `CTASection`, `FAQAccordion` | KEEP / light UPGRADE |

New, under `src/components/marketing/product/`: `InteractiveDashboardPreview` (Month selector updates every card; month-end wording), `InteractiveExpenseFormPreview` (category-specific fields, conditional fields, project fields that fill together, Recent values combobox), `InteractiveApprovalWorkflow`, `InteractiveReportPreview` (header sort/filter, Reset view, report history View/Viewing/Download of a synthetic CSV), `InteractiveBalanceTransfer` (send, awaiting acceptance, accept/reject), `InteractiveTeamPreview`, `InteractiveHowItWorksTour`, `ProductPreviewShell`, `demoData.ts`, `lazy.tsx` (below-the-fold demos are separate lazy chunks).

## 3) Pages
* **Home:** new hero + interactive dashboard, "Built for real operations finance" cards, expense form, approval, major reporting section, month-aware section, balances + My Teams, refreshed long-form copy, six-step flow, FAQ (10 buyer questions), CTA.
* **Features:** same six categories with refreshed lists; playable previews for Expense, Workflow (+My Teams), Balance and Analytics; full-width reporting demo.
* **How It Works:** Configure, Capture, Review, Approve, Balance, Report with a guided stepper around one fictional expense.
* **Pricing:** entitlements untouched (no new restrictions invented, new capabilities not placed behind a tier); wording modernised; quote-confirmation note.
* **Security:** accuracy pass (see §5). **SEO:** titles, descriptions, OG, JSON-LD feature list, FAQ schema (single source), static `index.html` meta.

## 4) Marketing claim audit
| Claim | Supporting implementation | Confidence |
|---|---|---|
| Configurable, category-specific expense forms | form builder templates + `expense_category_form_fields` | supported |
| Fields that appear after a selection | option branches (`expense_form_field_option_branches`) | supported |
| Project ID / name / unique ID captured and reported | configured fields carried into review and Detailed Expense | supported (as configurable fields) |
| Recent values, personal to each employee, not AI | Expense Field Memory (DOC-130); per-employee, eligible fields, org-flagged | supported |
| Optional supervisor / team leader / engineer / executive tiers | hierarchy + teams feature flags | supported |
| Team leads see only their team | `list_my_teams_overview`, team-scoped RLS | supported |
| Employee balances, transfer offers (accept/reject), returns, history | balance ledger, transfer offers, return requests | supported |
| Month-aware dashboard incl. month-end balance | `get_dashboard_stats_v2` (DOC-133) | supported (on this branch) |
| Exact Month and Year expense views | DOC-127 | supported |
| Server-generated reports, in-app preview, sort/filter, history, reopen as generated, CSV | DOC-131 (report export queue, preview v3, history) | supported (on this branch) |
| Filters on project/custom fields in reports | custom_field_filters in report parameters | supported |
| Audit records of approvals and changes | status history / audit logs | supported |
| Organization-scoped isolation via membership + RLS | `organization_memberships`, RLS policies | supported |
| Receipts under org-scoped paths, authenticated access | storage policies on the receipts bucket | supported (policy names reviewed, not re-tested here) |

Removed or rewritten because not provable: "Trusted by teams across industries" (now "Built for teams like these"), "Integrates With Your ERP" (now "complements"), "enterprise-grade security", "encryption at rest", "all database connections use SSL/TLS", "encrypted receipt storage", "Complete trail of all actions", and a JSON-LD `Offer` with `price: 0` (pricing is quote-based).

## 5) Security claim audit
Old "Each user belongs to one organization" / "One org per user" is gone; access is described as scoped to the active organization membership, with membership roles and database policies together preventing cross-organization access. Kept: role-based authorization, RLS, HTTPS, authenticated receipt access, file type/size limits, audit records, least privilege. Added none. No certifications are claimed (tests guard SOC 2 / ISO / HIPAA / bank-grade / enterprise-grade).

## 6) Owner attention (not changed by this pass)
* **Testimonials** are anonymous role-based quotes with no named customer. Confirm they are genuine and approved before launch.
* Enterprise plan bullet "Custom integrations" and the Growth/Enterprise entitlements pre-date this pass; confirm they are the intended commercial terms and that no direct ERP integration is implied.
* Reporting for large Daily Project ranges is deliberately not marketed.

## 7) Tests
`src/components/marketing/product/__tests__/interactivePreviews.test.tsx` (24: dashboard month switching, category fields, Recent values incl. keyboard, conditional fields, workflow, report sort/filter/reset/history, transfer accept/reject, teams, tour, zero backend touches) and `src/lib/__tests__/marketingContent.test.ts` (25: stale/unsupported claims, required messaging, pricing not invented, SEO/JSON-LD, screenshot ban, demo isolation, public routes, lazy loading).

## Revision log
| Date | Rev | By | Change |
|---|---|---|---|
| 2026-09-25 | 1.0 | Agent | Initial refresh. |
