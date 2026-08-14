/**
 * Shared marketing copy — single source for SEO meta, schema, and landing page content.
 */

import type { FAQItem } from "@/components/marketing/sections";

export const HOME_TITLE = "PesoWise | Smart Expense & Cash Flow Management";

export const HOME_DESCRIPTION =
  "PesoWise streamlines expense claims, hierarchy approvals, cash balances, and custom category fields—ERP-aligned and audit-ready for multi-org finance teams.";

/** OG/social headline (slightly longer than document title). */
export const HOME_OG_TITLE =
  "PesoWise by Unimisk — Expense Management That Integrates With Your ERP";

export const HOME_OG_DESCRIPTION =
  "Track employee expenses, automate multi-tier approvals, manage balances and transfer offers, and capture custom fields per category—built to complement your ERP.";

export const MARKETING_TAGLINE = "Smart Expense & Cash Flow Management";

export const SCHEMA_FEATURE_LIST = [
  "Expense submission with receipts and batch entry",
  "Multi-tier approval hierarchy and engineer verification",
  "Custom form builder with category-specific fields",
  "My Teams visibility for managers and supervisors",
  "Real-time balance tracking and transfer offers",
  "Multi-organization isolation with row-level security",
  "Reports with custom field filters and CSV export",
  "Audit trails and compliance-ready records",
] as const;

export const HOME_FAQ_ITEMS: FAQItem[] = [
  {
    question: "What is PesoWise?",
    answer:
      "PesoWise is a cloud expense management platform. Teams submit claims with receipts and custom category fields, follow configurable approval paths—including optional supervisor and executive tiers—and finance leaders see balances, transfer history, and audit trails in one place. It complements your ERP rather than replacing it.",
  },
  {
    question: "Who is PesoWise for?",
    answer:
      "Finance-led organizations, distributed operations teams, and SMEs that reimburse employees and need ERP-aligned reporting. Multi-location and multi-organization setups are supported with isolated data per tenant.",
  },
  {
    question: "Does PesoWise support custom expense fields?",
    answer:
      "Yes. Admins configure a form builder with base fields and category-specific templates—including conditional dropdown branches. Saved values appear on review, detail, and export views for authorized roles.",
  },
  {
    question: "How do approval hierarchies work?",
    answer:
      "Beyond optional engineer verification, organizations can enable team leader and executive review tiers, supervisor-first routing, and My Teams dashboards so managers see member expenses without full admin access.",
  },
  {
    question: "How does balance and cash management work?",
    answer:
      "Admins and cashiers allocate funds with documented transfers. Organizations can require recipients to accept transfer offers before balances update. Approved expenses deduct automatically with a full cash transfer history.",
  },
  {
    question: "Does PesoWise work with our ERP?",
    answer:
      "Yes. PesoWise handles expense workflows—claims, approvals, receipts, custom fields, and exports—so finance can reconcile and post into the ERP or accounting system you already use.",
  },
  {
    question: "How do I get started?",
    answer:
      "Use the contact page to tell us about your workflow. We will help with onboarding, configuration, and training so your first expenses run on PesoWise quickly.",
  },
];

export const FEATURES_META_DESCRIPTION =
  "See how PesoWise handles expense capture, custom form fields, hierarchy approvals, My Teams, batch entry, balances, transfer offers, multi-org setup, analytics, and audit trails.";

export const HOW_IT_WORKS_META_DESCRIPTION =
  "Learn PesoWise’s workflow from receipt upload through hierarchy review, verification, admin approval, balance updates, and audit logging—for ERP-aligned expense operations.";

export const PRICING_META_DESCRIPTION =
  "Starter, Growth, and Enterprise plans for PesoWise. Compare capabilities including form builder, hierarchy approvals, and teams—contact us for a tailored quote.";

export const expenseFeatures = [
  "Create expense reports with title, vendor, date, and amount",
  "Custom form builder with category-specific fields and conditional dropdown branches",
  "Batch expense entry with shared or per-line receipt attachments",
  "Upload receipts in PDF, JPG, or PNG format (max 2MB combined)",
  "Track expense status through the entire workflow",
  "Optional employee ID login for enterprise identity",
];

export const workflowFeatures = [
  "Multi-step workflow: Draft → Submitted → Under Review → Verified → Approved/Rejected",
  "Optional hierarchy tiers: team leader, executive, and supervisor-first routing",
  "Optional engineer verification for on-site validation before approval",
  "My Teams view for managers to monitor member expenses and exports",
  "Configurable approval limits and thresholds per category",
  "Comments and feedback at each stage; custom fields visible on review",
];

export const balanceFeatures = [
  "Real-time balance visibility across all expense funds",
  "Add funds with notes; optional transfer offers with recipient accept/reject",
  "Admin self-credit and documented cash transfer history",
  "Automatic balance deduction when expenses are approved",
  "Balance transfers between roles with full audit trail",
  "Return request management for unused funds",
];

export const multiorgFeatures = [
  "Organization-level data isolation using row-level security",
  "Custom settings and feature flags per organization",
  "Organization-specific expense categories, locations, and form templates",
  "Consolidated reporting across entities for management",
  "Role-based access control per organization",
];

export const analyticsFeatures = [
  "Role-based dashboards with relevant metrics for each user type",
  "Reports filtered by custom dropdown and checkbox field values",
  "Expense trends and budget utilization by category and location",
  "CSV export for admins to perform custom analysis",
  "Custom date range filtering for flexible reporting",
];

export const auditFeatures = [
  "Timestamped action logs for every significant change",
  "Actor tracking for all changes (who did what, when)",
  "Receipt and document preservation for compliance",
  "Custom form field values inherit expense visibility rules",
  "Historical data access with full search capabilities",
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
      "Yes. Admins assign form field templates to categories, configure display on submit and review, and use conditional dropdown branches when a specific option is selected.",
  },
  {
    question: "Can I customize the approval workflow?",
    answer:
      "Yes. Enable engineer verification, hierarchy tiers (team leader / executive), supervisor-first routing, and approval limits per category to match your organization.",
  },
  {
    question: "How does multi-organization work?",
    answer:
      "Each organization has its own isolated data, settings, categories, and user permissions. Administrators can manage multiple organizations while maintaining complete data separation.",
  },
  {
    question: "What reporting options are available?",
    answer:
      "Role-based dashboards, team-scoped reports, custom field filters, trend analysis, and CSV exports. Admin users can analyze data across categories and custom attributes.",
  },
];

export const workflowFaqItems: FAQItem[] = [
  {
    question: "Is engineer verification always required?",
    answer:
      "No. Engineer verification is optional. Some expenses may route through hierarchy reviewers (team leader or executive) before admin approval, depending on your configuration.",
  },
  {
    question: "What happens if an expense is rejected?",
    answer:
      "Rejected expenses return to the employee with feedback. They can revise and resubmit with corrections, updated receipts, or custom field values.",
  },
  {
    question: "Are custom fields visible during review?",
    answer:
      "Yes. Saved category-specific field values appear on review dialogs, expense detail, and batch review for every role authorized to view the parent expense.",
  },
  {
    question: "How are balances updated after approval?",
    answer:
      "Once approved, the corresponding balance updates automatically in real time and is logged in cash transfer history for audit purposes.",
  },
];

export const TESTIMONIALS = [
  {
    quote:
      "We finally replaced spreadsheet tracking. Hierarchy approvals and receipt capture mean field teams submit once and finance sees the full picture.",
    author: "Operations manager",
    role: "Construction & infrastructure, Gujarat",
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
      "Custom form builder & category fields",
      "Hierarchy approvals & My Teams",
      "Engineer verification",
      "Batch expense entry",
      "Transfer offers & multi-org support",
      "Advanced analytics & CSV export",
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
