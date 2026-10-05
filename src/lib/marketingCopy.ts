/**
 * Shared marketing copy — single source for SEO meta, schema, and landing page content.
 *
 * Buyer-outcome language only: no internal implementation terms, no customer
 * numbers, and no claim the product does not demonstrably support (see
 * Documentations MD/marketing-product-refresh.md for the claim audit).
 */

import type { FAQItem } from "@/components/marketing/sections";

export const HOME_TITLE = "PesoWise | Operations Expense Management Software";

export const HOME_DESCRIPTION =
  "Operations expense management with configurable expense forms, multi-level approvals, employee cash balances, month-wise dashboards and audit-ready reporting for project-based teams.";

/** OG/social headline (slightly longer than document title). */
export const HOME_OG_TITLE = "PesoWise by Unimisk — Expense Management Built Around How You Operate";

export const HOME_OG_DESCRIPTION =
  "Capture expenses with configurable fields, route them through your approval hierarchy, manage employee balances and turn thousands of transactions into audit-ready reports. Complements your ERP.";

export const MARKETING_TAGLINE = "Operations Expense Management";

/** Homepage hero. */
export const HERO_HEADING = "Expense management built around the way your business already works";
export const HERO_BODY =
  "Capture expenses, bills and approvals in one place, with workflows that adapt to your teams, policies and processes, then turn thousands of transactions into audit-ready reports.";
export const HERO_CAPABILITY_LINE =
  "Custom expense forms · Multi-level approvals · Live balances · Month-wise dashboards · Advanced reporting";
export const HERO_SUBLINE = "Stop managing business expenses through spreadsheets, WhatsApp and scattered receipts.";

/** Primary/secondary CTA labels, used consistently across the site. */
export const CTA_PRIMARY = "Book a Demo";
export const CTA_SECONDARY = "See How It Works";
export const CTA_PRICING = "Discuss Your Requirements";

/**
 * The core product-philosophy section: PesoWise configures around an
 * organization's existing process rather than asking the organization to
 * redesign itself around the software. Repeated across Home, Features and
 * How It Works so it reads as a genuine philosophy, not one bullet point.
 */
export const ADAPT_SECTION = {
  heading: "Your company already has a process. Keep it.",
  kicker: "Your process should shape the software, not the other way around.",
  body: "Every organization handles expenses differently. Some require one approval. Others require several levels across managers, departments, branches or finance teams. PesoWise is designed to work around those structures instead of forcing every company into the same workflow.",
  areas: [
    "Roles & permissions",
    "Approval hierarchies",
    "Expense categories",
    "Custom fields",
    "Departments",
    "Branches & entities",
    "Workflow stages",
    "Expense policies",
    "Reporting structures",
  ],
  examples: [
    { label: "One possible chain", steps: ["Employee", "Manager", "Department Head", "Finance"] },
    { label: "A site-based chain", steps: ["Site Employee", "Site Manager", "Accounts"] },
    { label: "A simple chain", steps: ["Employee", "Admin Review"] },
  ],
  disclaimer: "Example approval chains — your organization configures its own.",
  scopeNote:
    "Configuration is what an administrator can already do inside PesoWise. A genuinely organization-specific requirement, or a connection to another system, is scoped individually rather than promised in advance.",
} as const;

export const PROBLEM_SECTION = {
  heading: "Business expenses shouldn't live across five different places.",
  intro: "Most growing teams still manage expenses through a mix of:",
  items: [
    "Bills shared over WhatsApp",
    "Expenses tracked by hand in a spreadsheet",
    "Receipts that go missing",
    "Managers chasing employees for details",
    "Approvals buried in chat threads",
    "No clear owner for a pending expense",
    "A slow, manual month-end reconciliation",
    "Limited visibility across teams or branches",
  ],
  transition: "PesoWise brings the entire expense workflow into one controlled system.",
} as const;

export const COMPARISON_SECTION = {
  heading: "From scattered expense tracking to one clear workflow.",
  body: "Spreadsheets record information. PesoWise manages the workflow around it.",
  oldWay: {
    label: "Old way",
    items: ["WhatsApp messages", "Spreadsheets", "Paper receipts", "Email approvals", "Manual follow-ups", "Unclear status"],
  },
  pesowise: {
    label: "PesoWise",
    items: [
      "Structured expense records",
      "Bills attached to the transaction",
      "A defined approval workflow",
      "Clear approval responsibility",
      "Visible status at every step",
      "Organized, exportable reporting",
    ],
  },
} as const;

export const USE_CASES = [
  { title: "Manufacturing", description: "Track operational and department expenses across employees and locations." },
  { title: "Construction & field operations", description: "Keep site expenses, bills and approvals organized as work moves between sites." },
  { title: "Multi-location businesses", description: "Maintain one structured expense workflow across branches instead of a different process per site." },
  { title: "Agencies & professional services", description: "Give teams a simple way to submit expenses while finance keeps oversight." },
  { title: "Growing businesses", description: "Move away from informal, ad-hoc expense tracking without taking on unnecessary complexity." },
] as const;

/** "Built for real operations finance" cards (outcomes, not implementation). */
export const CAPABILITY_CARDS = [
  {
    id: "forms",
    title: "Configurable expense forms",
    description:
      "Capture the details your finance team actually needs, from project IDs and locations to vehicle or site-specific information.",
  },
  {
    id: "approvals",
    title: "Approval hierarchies",
    description:
      "Route spend through supervisors, team leaders, engineers or executives before final approval, wherever your organization reviews it.",
  },
  {
    id: "balances",
    title: "Employee balances",
    description:
      "See where every employee's funds stand: additions, approved spend, transfers, returns and a full balance history.",
  },
  {
    id: "projects",
    title: "Project-level data",
    description:
      "Carry project and operational fields from submission through review to reporting, so spend can be read by project.",
  },
  {
    id: "months",
    title: "Month-aware insights",
    description:
      "Switch the dashboard between months to review expenses, pending amounts and month-end balances for the period you are closing.",
  },
  {
    id: "reporting",
    title: "Audit-ready reporting",
    description:
      "Generate detailed reports, inspect them in the browser with spreadsheet-style controls, reopen past reports and export CSV.",
  },
] as const;

/** Section copy for the interactive demos. */
export const FORM_SECTION = {
  heading: "Expense forms that match your operations",
  body: "Configure category-specific fields for projects, locations, vehicles, departments or the information your finance team actually needs. Forms can adapt as employees make selections, while Recent values make repeat entries faster.",
  note: "Recent values are personal to each employee.",
} as const;

export const APPROVAL_SECTION = {
  heading: "Approval paths that match your hierarchy",
  body: "Route expenses through supervisors, team leaders, engineers, executives or admins depending on how your organization reviews spending. Every tier is optional and configurable. Managers can see their own teams without receiving organization-wide admin access.",
} as const;

export const REPORTING_SECTION = {
  heading: "Reporting without going back to spreadsheets",
  body: "Generate detailed reports on the server, preview thousands of rows directly inside PesoWise, inspect the result with spreadsheet-style controls, reopen past reports and export the exact snapshot when you need it.",
  bullets: [
    "Server-generated reports that handle large datasets",
    "In-app preview with spreadsheet-style sorting and filtering",
    "Filters on project and custom fields",
    "Report history that reopens a past report exactly as generated",
    "CSV export of the same snapshot",
  ],
} as const;

export const MONTH_SECTION = {
  heading: "See the month, not just the total",
  body: "Switch between months to review expenses, pending amounts and balances for the period you're working on, without rebuilding reports. For a past month the dashboard shows the balance as of that month's end. Expense lists offer the same exact Month and Year view, so you can jump straight to the month you need without loading an entire history.",
} as const;

export const BALANCE_SECTION = {
  heading: "Know where employee funds stand",
  body: "Track additions, approved expense deductions, transfers, returns and balance history in one place.",
} as const;

export const TEAMS_SECTION = {
  heading: "Give managers visibility without giving them everything",
  body: "Supervisors and team leads can review their members' expenses and reports without receiving organization-wide administrator access.",
} as const;

export const SCHEMA_FEATURE_LIST = [
  "Configurable expense forms with category-specific and conditional fields",
  "Multi-tier approvals, team-scoped review, and optional engineer verification",
  "Employee cash balances, transfers, transfer offers, and balance history",
  "Month-aware dashboards and exact month/year expense views",
  "Server-generated reports with in-app preview, sorting, filtering, history, and CSV export",
  "Project and operational fields available throughout review and reporting",
  "Employee-specific Recent values for faster repeat expense entry",
  "Multi-organization access controls and data isolation",
  "Audit trails for expense and approval activity",
] as const;

export const HOME_FAQ_ITEMS: FAQItem[] = [
  {
    question: "What is PesoWise?",
    answer:
      "PesoWise is operations expense management software for organizations with real approval hierarchies, employee cash balances, project-level data and serious reporting needs. Teams capture expenses with configurable fields and receipts, route them through your review hierarchy, and finance gets dashboards, balances and audit-ready reports. It complements your ERP or accounting system rather than replacing it.",
  },
  {
    question: "Can expense forms be customized?",
    answer:
      "Yes. Admins configure category-specific fields, including fields that appear only after an employee makes a certain selection. Saved values are visible on review screens and in reports for authorized roles.",
  },
  {
    question: "How do approval hierarchies work?",
    answer:
      "Expenses can be routed through optional supervisor, team leader, engineer and executive tiers before final admin approval. Which tiers apply is configurable for your organization, and none of them is mandatory.",
  },
  {
    question: "Can managers review only their team?",
    answer:
      "Yes. My Teams lets supervisors and team leads review their own members' expenses and reports without organization-wide administrator access.",
  },
  {
    question: "How does balance management work?",
    answer:
      "Admins and cashiers add funds to employee balances and can send transfer offers that the recipient accepts or rejects. Approved expenses reduce the relevant balance, and returns and transfers are kept in a balance history.",
  },
  {
    question: "Can we filter expenses by month?",
    answer:
      "Yes. Expense lists have an exact Month and Year view, and the dashboard can be switched to a month to show that period's expenses, pending amounts and month-end balance.",
  },
  {
    question: "What reporting options are available?",
    answer:
      "Admins can generate reports on the server, preview results inside PesoWise, filter and sort report columns, reopen previous generated reports and export CSV files. Reports can include project and organization-specific custom fields.",
  },
  {
    question: "Does PesoWise support project-specific information?",
    answer:
      "Yes. Project IDs, project names and other operational fields can be captured on the expense form, shown during review and carried into reports, so spend can be analysed by project.",
  },
  {
    question: "Does PesoWise work with our ERP?",
    answer:
      "PesoWise complements your ERP or accounting system. It captures and governs operational expense activity, so finance can reconcile and post the results into the system you already use. Talk to us about your setup and export needs.",
  },
  {
    question: "Is PesoWise accounting software?",
    answer:
      "No. PesoWise is expense management, petty-cash control and operational expense workflow software. It captures spend, approvals and balances so finance can reconcile and post the result into the accounting or ERP system you already use.",
  },
  {
    question: "Can PesoWise match our approval process?",
    answer:
      "PesoWise is designed to be configured around your organization's existing approval process, using its roles, hierarchy tiers, categories and fields, rather than asking you to redesign your process to fit the software.",
  },
  {
    question: "Can workflows be customized?",
    answer:
      "PesoWise includes configurable workflows and organization settings out of the box. A requirement outside that configuration can be evaluated as scoped customization; we don't promise that every customization is possible.",
  },
  {
    question: "Can different roles have different access?",
    answer:
      "Yes. Roles and permissions are enforced in the application and the database, so a person only sees and acts on what their role and organization membership allow.",
  },
  {
    question: "Is PesoWise available internationally?",
    answer:
      "Yes. PesoWise is built for businesses internationally, not only in India. We do not make country-specific tax or compliance claims as part of the base product.",
  },
  {
    question: "How do I get started?",
    answer:
      "Use the contact page to tell us about your current expense process. We will help with onboarding, configuration, and training so your first expenses run on PesoWise quickly.",
  },
];

export const FEATURES_META_DESCRIPTION =
  "Explore PesoWise: configurable expense forms, multi-level approvals, My Teams, employee balances and transfers, month-aware dashboards, server-generated reports with in-app preview, and audit trails.";

export const HOW_IT_WORKS_META_DESCRIPTION =
  "See how PesoWise works: configure forms and approval rules, capture expenses, review through your hierarchy, approve, update balances and report with audit-ready detail.";

export const PRICING_META_DESCRIPTION =
  "Starter, Growth, and Enterprise plans for PesoWise. Compare capabilities including configurable forms, hierarchy approvals, and teams. Contact us for a tailored quote.";

export const SECURITY_META_DESCRIPTION =
  "How PesoWise protects expense data: role-based access, organization-scoped isolation enforced in the database, authenticated receipt access and audit records.";

/** Pricing page: Platform / Organization Setup / Additional Requirements framing. */
export const PRICING_HERO = {
  heading: "Pricing that fits the way your organization works",
  body: "Start with PesoWise's core expense-management platform and configure it around your organization's users, workflows and operational requirements.",
} as const;

export const PRICING_TIERS = [
  {
    id: "platform",
    title: "Platform",
    description: "The core PesoWise expense-management platform: capture, approvals, balances, reporting and everything on the Features page.",
  },
  {
    id: "setup",
    title: "Organization Setup",
    description: "Configuring users, roles, teams, categories, permissions and your approval hierarchy inside PesoWise's existing functionality.",
  },
  {
    id: "additional",
    title: "Additional Requirements",
    description: "Advanced workflow customization, organization-specific functionality or integrations, scoped individually where they go beyond what's configurable today.",
  },
] as const;

export const PRICING_REQUIREMENTS_PROMPT =
  "Need a workflow specific to your organization? Tell us how your process works. We'll determine what can be configured directly and whether additional customization is required.";

export const PRICING_FACTORS = [
  "Number of users",
  "Organization size",
  "Entities or branches",
  "Workflow complexity",
  "Customization requirements",
  "Integration requirements",
] as const;

export const pricingFaqItems: FAQItem[] = [
  {
    question: "Do we need to change our existing approval process?",
    answer: "No. PesoWise is designed to be configured around your organization's existing expense workflow wherever possible.",
  },
  {
    question: "Can we create different workflows for different teams?",
    answer: "Different categories, fields and approval routing can be configured per team or category. A requirement outside that configuration is scoped individually.",
  },
  {
    question: "Can PesoWise be customized?",
    answer: "PesoWise includes configurable workflows and organization settings. Requirements outside the existing configuration can be evaluated as scoped customization.",
  },
  {
    question: "Can PesoWise integrate with our existing systems?",
    answer: "Integration requirements can be assessed based on the systems and workflow involved. We don't promise a specific integration until it has been scoped.",
  },
  {
    question: "Is PesoWise only for Indian businesses?",
    answer: "No. PesoWise is intended for businesses internationally. We do not make country-specific tax or compliance claims as part of the base product.",
  },
  {
    question: "How does pricing work?",
    answer: "Pricing reflects the platform plus your organization setup, with additional requirements such as advanced customization or integrations scoped separately. Contact us for a proposal based on your team size and workflow.",
  },
] as const;

/** Contact page. */
export const CONTACT_HERO = {
  heading: "Tell us how your company handles expenses today",
  body: "We'll help determine how PesoWise can fit into that workflow.",
} as const;

export const expenseFeatures = [
  "Category-specific expense forms with conditional fields that appear as employees make selections",
  "Project and operational fields, such as Project ID, location or vehicle details",
  "Recent values that speed up repeat entries while keeping every field open to new input",
  "Batch expense entry with shared or per-line receipt attachments",
  "Bills and receipts stay attached to the expense they belong to, in PDF, JPG, or PNG format (max 2MB combined)",
  "Exact Month and Year view of your expenses",
  "Track expense status through the entire workflow",
];

export const workflowFeatures = [
  "Optional hierarchy tiers: supervisor, team leader and executive review",
  "Optional engineer verification for on-site validation before approval",
  "Team-scoped review: managers see their own teams, not the whole organization",
  "My Teams view for monitoring member expenses and reports",
  "Roles and permissions enforced in the application and the database, not just the screen",
  "Configurable approval limits and thresholds per category",
  "Comments and feedback at each stage, with custom fields visible on review",
  "Status and history stay visible: draft, submitted, under review, approved or rejected",
];

export const balanceFeatures = [
  "Live balance per employee, with month-end balances in the dashboard",
  "Cash additions with notes and a documented history",
  "Transfer offers the recipient can accept or reject",
  "Return flows for unused funds",
  "Automatic balance reduction when expenses are approved",
  "Balance history for employees and finance teams",
];

export const multiorgFeatures = [
  "Structure expense management around your teams, departments, branches or entities",
  "Organization-scoped access based on active membership and role",
  "Isolated data between organizations, enforced in the database",
  "Custom settings and feature flags per organization",
  "Organization-specific categories, locations, and form templates",
  "Role-based access control within each organization",
];

export const analyticsFeatures = [
  "Month-aware dashboard: switch months to see expenses, pending amounts and balances",
  "Server-generated detailed reports that handle large datasets",
  "In-app report preview with spreadsheet-style sorting and filtering",
  "Report history that reopens past reports as they were generated",
  "Filters on project and custom field values",
  "CSV export of the exact report snapshot",
];

export const auditFeatures = [
  "Timestamped status history for every significant change",
  "Actor tracking for approvals and changes (who did what, when)",
  "Reports that can be reopened exactly as generated",
  "Receipt and document preservation",
  "Custom form field values follow the visibility rules of their expense",
];

export const featuresFaqItems: FAQItem[] = [
  {
    question: "What file formats are supported for receipt uploads?",
    answer:
      "PesoWise supports PDF, JPG, and PNG file formats for receipt uploads. Total upload size is limited to 2MB combined for optimal performance.",
  },
  {
    question: "Can we add custom fields per expense category?",
    answer:
      "Yes. Admins assign fields to categories, choose where they appear on submit and review, and can make fields appear only after a specific selection.",
  },
  {
    question: "Can I customize the approval workflow?",
    answer:
      "Yes. You can enable engineer verification, hierarchy tiers such as team leader and executive, supervisor-first routing, and approval limits per category to match your organization.",
  },
  {
    question: "How does multi-organization work?",
    answer:
      "Each organization has its own isolated data, settings, categories, and permissions. Access is scoped to a user's active organization membership and role.",
  },
  {
    question: "What reporting options are available?",
    answer:
      "Admins can generate reports on the server, preview results inside PesoWise, filter and sort report columns, reopen previous generated reports and export CSV files. Reports can include project and organization-specific custom fields.",
  },
  {
    question: "What are Recent values?",
    answer:
      "PesoWise can surface an employee's recently used values for eligible fields, making recurring entries faster while keeping the field open to new values. They are personal to each employee.",
  },
];

export const workflowFaqItems: FAQItem[] = [
  {
    question: "Is engineer verification always required?",
    answer:
      "No. Engineer verification is optional. Expenses can route through hierarchy reviewers such as a team leader or executive before admin approval, depending on your configuration.",
  },
  {
    question: "What happens if an expense is rejected?",
    answer:
      "Rejected expenses return to the employee with feedback. They can revise and resubmit with corrections, updated receipts, or custom field values.",
  },
  {
    question: "Are custom fields visible during review?",
    answer:
      "Yes. Saved category-specific field values appear on review screens and expense detail for every role authorized to view the expense.",
  },
  {
    question: "How are balances updated after approval?",
    answer:
      "Once an expense is approved, the relevant balance is reduced and the change is recorded in balance history for audit purposes.",
  },
];

export const TESTIMONIALS = [
  {
    quote:
      "We finally replaced spreadsheet tracking. Hierarchy approvals and receipt capture mean field teams submit once and finance sees the full picture.",
    author: "Operations manager",
    role: "Construction & infrastructure",
  },
  {
    quote:
      "Multi-site balances and transfer history gave us audit-ready records without chasing people on chat. Custom category fields match how we actually classify spend.",
    author: "Finance controller",
    role: "Multi-location manufacturing",
  },
  {
    quote:
      "My Teams lets regional leads monitor member expenses without admin access. Exports with custom field filters saved us hours at month-end.",
    author: "Regional manager",
    role: "Distributed services company",
  },
  {
    quote:
      "Transfer offers with accept/reject put cashiers and admins on the same page. Approvals and balance updates stay in sync across our org chart.",
    author: "Admin lead",
    role: "Mid-size operations group",
  },
] as const;

export const PRICING_PLANS = [
  {
    name: "Starter",
    description: "For small teams getting started",
    price: "Contact us",
    popular: false,
    cta: "Contact Sales",
    features: [
      "Up to 5 users",
      "Expense reports & receipts",
      "Basic approval workflow",
      "Balance management",
      "Basic analytics dashboard",
      "Email support",
    ],
  },
  {
    name: "Growth",
    description: "For growing organizations",
    price: "Contact us",
    popular: true,
    cta: "Contact Sales",
    features: [
      "Up to 25 users",
      "Everything in Starter",
      "Configurable expense forms & category fields",
      "Hierarchy approvals & My Teams",
      "Engineer verification",
      "Batch expense entry",
      "Transfer offers & multi-org support",
      "Advanced analytics, reporting & CSV export",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    description: "For large organizations",
    price: "Contact us",
    popular: false,
    cta: "Contact Sales",
    features: [
      "Unlimited users",
      "Everything in Growth",
      "Custom approval workflows & feature flags",
      "Employee ID login",
      "Custom analytics & reporting",
      "Dedicated support & SLA",
      "Custom integrations",
    ],
  },
] as const;

/** Security page copy (kept here so tests can guard the claims). */
export const SECURITY_ORG_ANSWER =
  "Access is scoped to the user's active organization membership. Organization identity, membership roles and database policies work together to prevent unauthorized cross-organization access, and data such as expenses, receipts and balances is isolated per organization.";

export const SECURITY_STORAGE_ANSWER =
  "Data is stored on managed infrastructure and is accessed over HTTPS. Access to it is enforced in the database with row level security, not only in the application.";

export const SECURITY_SEO_PARAGRAPH =
  "PesoWise builds defense-in-depth into the application and database: row level security, role-based access control, organization-scoped isolation and audit records. Receipts are kept under organization-scoped paths and are available only to authenticated members of the organization.";
