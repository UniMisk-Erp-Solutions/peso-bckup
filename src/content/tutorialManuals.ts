export type TutorialRole =
  | "admin"
  | "cashier"
  | "engineer"
  | "employee"
  | "team_leader"
  | "executive";

export interface TutorialSection {
  id: string;
  title: string;
  paragraphs: string[];
}

export interface TutorialManual {
  role: TutorialRole;
  displayName: string;
  summary: string;
  lastUpdated: string;
  quickLinks: Array<{ label: string; route?: string }>;
  sections: TutorialSection[];
}

/** @deprecated Runtime uses src/locales/<lang>/help.json; generator script only. */
export const tutorialManuals: Partial<Record<TutorialRole, TutorialManual>> = {
  admin: {
    role: "admin",
    displayName: "Admin Operations Manual",
    summary: "Complete module-by-module guide to configure and run PesoWise for your organization.",
    lastUpdated: "May 2026",
    quickLinks: [
      { label: "User Management", route: "/admin/users" },
      { label: "Category Management", route: "/admin/categories" },
      { label: "Expense Review", route: "/admin/expenses" },
      { label: "Reports", route: "/admin/reports" },
      { label: "Balances", route: "/balances" },
      { label: "Settings", route: "/settings" },
      { label: "Notifications", route: "/notifications" },
    ],
    sections: [
      {
        id: "admin-module-0-login",
        title: "Module 0: Login and Admin Scope",
        paragraphs: [
          "Login to PesoWise and confirm you are in the admin account for the correct organization.",
          "Admin scope includes: users, categories, form templates, approval governance, balances, reports, notifications, and organization settings.",
          "Before any action, verify organization context in the top bar so changes are applied to the intended org.",
        ],
      },
      {
        id: "admin-module-1-user-management",
        title: "Module 1: User Management (Create, Update, Assign)",
        paragraphs: [
          "Open User Management from Admin menu.",
          "Create single users with correct role (admin, manager, cashier, employee) and complete profile details.",
          "For large onboarding, use Bulk Users Upload CSV and first run Dry-Run to validate data before final upload.",
          "Check organization capacity in the uploader and ensure seat limits are available before import.",
          "After creation, verify hierarchy assignments (employee -> manager, cashier -> location/manager, manager -> relevant mappings).",
          "If a user should no longer operate, deactivate/remove access to avoid accidental approvals.",
        ],
      },
      {
        id: "admin-module-2-category-management",
        title: "Module 2: Category Management",
        paragraphs: [
          "Open Category Management to add, edit, activate, or archive categories.",
          "Keep naming consistent (for example Fuel, Lodging, Client Travel) so reporting remains clean.",
          "Avoid duplicate or near-duplicate category names; duplicates split analytics and create confusion for employees.",
          "When policy changes, update categories and communicate expected usage to managers and employees.",
        ],
      },
      {
        id: "admin-module-3-form-templates",
        title: "Module 3: Expense Form Templates and Field Rules",
        paragraphs: [
          "Go to Settings and configure base fields and custom form field templates.",
          "Set each field's visibility and required status based on your policy (submit/review/detail stages).",
          "Use custom fields to capture business-specific metadata like project code, vehicle number, vendor, route, or approval note.",
          "When tiered dropdowns are enabled (Master Admin), edit a dropdown template and expand each option to add sub-fields shown only when that option is selected.",
          "Validate template behavior by creating a test expense after changes.",
        ],
      },
      {
        id: "admin-module-4-settings",
        title: "Module 4: Settings Page (Organization Controls)",
        paragraphs: [
          "Use Settings to manage organization-level controls such as approval thresholds and attachment rules.",
          "Maintain location and operational settings required by cashier/manager assignment logic.",
          "Review backup/restore options periodically and ensure export/backup processes are tested.",
          "Any settings update should be followed by a quick workflow test to confirm expected behavior.",
        ],
      },
      {
        id: "admin-module-5-approval-review",
        title: "Module 5: Review and Approve Expenses",
        paragraphs: [
          "Open Expense Review and process pending/escalated requests in queue order.",
          "For each expense: verify title, category, location, amount, receipt readability, and workflow history/comments.",
          "Approve policy-compliant claims; reject non-compliant or incomplete claims with clear corrective guidance.",
          "For rejected entries, use precise comments so users can resubmit successfully in one attempt.",
        ],
      },
      {
        id: "admin-module-6-approval-governance",
        title: "Module 6: Approval Governance and Threshold Rules",
        paragraphs: [
          "Ensure manager threshold logic is correctly configured so high-value claims route to admin.",
          "Regularly review threshold values against finance policy and risk levels.",
          "When threshold policy changes, update Settings and notify managers to avoid inconsistent decisions.",
        ],
      },
      {
        id: "admin-module-7-balances",
        title: "Module 7: Balances and Transfers",
        paragraphs: [
          "Open Balances to fund users/cashiers and maintain cash flow continuity.",
          "Use notes on manual balance edits for audit traceability.",
          "Cross-check transfer history and returned amounts to prevent reconciliation mismatch.",
          "Investigate large or frequent manual adjustments and resolve root causes.",
        ],
      },
      {
        id: "admin-module-8-reports",
        title: "Module 8: Reports and Analytics",
        paragraphs: [
          "Use Reports to analyze spending by category, employee, manager, location, and date range.",
          "Export CSV/PDF outputs for finance, audit, and management reviews.",
          "Track recurring anomalies (sudden spikes, repeated rejections, unusual category distributions).",
          "Use insights to refine category definitions, field templates, and approval policy.",
        ],
      },
      {
        id: "admin-module-9-notifications",
        title: "Module 9: Notifications and Operational Monitoring",
        paragraphs: [
          "Monitor notifications continuously for new submissions, escalations, approvals, rejections, and return-related actions.",
          "Prioritize old pending items first to reduce aging queues.",
          "Use notification trends to identify bottlenecks in specific teams or users.",
        ],
      },
      {
        id: "admin-module-10-admin-own-expense",
        title: "Module 10: Admin Self Expense Flow",
        paragraphs: [
          "Admin can also submit own expenses from My Expenses -> Add Expense.",
          "Fill form with complete details and upload receipt for transparency.",
          "Track status and history exactly like any other user-submitted expense.",
        ],
      },
      {
        id: "admin-module-11-daily-checklist",
        title: "Module 11: Daily Admin Checklist",
        paragraphs: [
          "1) Clear pending approvals and escalations.",
          "2) Validate user/role/hierarchy changes requested that day.",
          "3) Review balance adjustments and transfer anomalies.",
          "4) Spot-check reports for policy drift and unusual trends.",
          "5) Ensure notification backlog is near zero before day close.",
        ],
      },
    ],
  },
  cashier: {
    role: "cashier",
    displayName: "Cashier / Finance Guide",
    summary: "Monitor, manage, and settle expenses across employees and managers.",
    lastUpdated: "May 2026",
    quickLinks: [
      { label: "Balances", route: "/balances" },
      { label: "Cashier Transactions", route: "/cashier/transactions" },
      { label: "Transfer History", route: "/cash-transfer-history" },
    ],
    sections: [
      {
        id: "cashier-getting-started",
        title: "Step 1: Login to PesoWise",
        paragraphs: [
          "Open PesoWise and enter your login credentials.",
          "You will land directly on the dashboard after successful login.",
        ],
      },
      {
        id: "cashier-dashboard-overview",
        title: "Part 1: Dashboard Overview",
        paragraphs: [
          "From the dashboard, you can view the overall expense summary.",
          "Track balances across employees and managers.",
          "Monitor recent transactions and access analytics insights for cash planning.",
        ],
      },
      {
        id: "cashier-add-own-expense",
        title: "Part 2: Add Your Own Expense",
        paragraphs: [
          "Go to My Expenses from the sidebar.",
          "Click Add Expense and fill Category, Title, Location, Amount, and receipt (if applicable).",
          "Click Submit to record the expense in the system.",
        ],
      },
      {
        id: "cashier-track-all-expenses",
        title: "Part 3: View & Track All Expenses",
        paragraphs: [
          "Cashier can view expenses of all employees and managers.",
          "Track submitted expenses, approved expenses, and pending items.",
        ],
      },
      {
        id: "cashier-settlement-balance",
        title: "Part 4: Settlement & Balance Tracking",
        paragraphs: [
          "Review approved expenses and compare approved amount vs actual expense.",
          "Example: Approved INR 149,999 and actual INR 100,000 means balance INR 49,999.",
          "Collect the remaining amount from employee via cash or transfer.",
          "Update the system with actual expense, returned amount, and mark as Settled/Closed.",
          "Always add notes for exceptions (late submission, partial return, receipt mismatch) for audit clarity.",
        ],
      },
      {
        id: "cashier-analytics",
        title: "Part 5: Analytics & Insights",
        paragraphs: [
          "Use analytics to track highest-spend categories, department-wise spending, and overall financial trends.",
        ],
      },
      {
        id: "cashier-notifications",
        title: "Part 6: Notifications",
        paragraphs: [
          "Monitor notifications for new expenses and manager/admin approvals.",
          "Use these updates to stay current in real time.",
        ],
      },
      {
        id: "cashier-settings",
        title: "Part 7: Settings",
        paragraphs: [
          "Open Settings to manage available platform preferences and operational controls.",
        ],
      },
      {
        id: "cashier-end-of-day-check",
        title: "End-of-Day Check",
        paragraphs: [
          "Ensure all collected returns are recorded and matched against transfer history.",
          "Review any pending settlement items and carry forward action notes for next day follow-up.",
        ],
      },
    ],
  },
  engineer: {
    role: "engineer",
    displayName: "Manager Manual",
    summary: "Add your own expenses, review employee requests, and approve within manager limits.",
    lastUpdated: "May 2026",
    quickLinks: [
      { label: "Manager Review", route: "/review" },
      { label: "Notifications", route: "/notifications" },
    ],
    sections: [
      {
        id: "manager-getting-started",
        title: "Step 1: Login to PesoWise",
        paragraphs: [
          "Open PesoWise and enter your login credentials.",
          "After login, you will land on the dashboard.",
        ],
      },
      {
        id: "manager-add-own-expense",
        title: "Part 1: Adding Your Own Expense (Manager)",
        paragraphs: [
          "Go to My Expenses from the left sidebar.",
          "Click Add Expense and fill Category, Title, Location, Amount, and upload receipt.",
          "Click Submit. Your expense appears in My Expenses with status Pending / Approved / Rejected.",
        ],
      },
      {
        id: "manager-review-employee-expenses",
        title: "Part 2: Reviewing Employee Expenses",
        paragraphs: [
          "Check Notifications on the dashboard for newly submitted expenses.",
          "Go to Review Expenses from the sidebar to view employee requests.",
          "Open View / Approve to review full details, amount, and receipt attachment.",
          "Verify (approve) or reject with remarks when needed.",
          "Use clear rejection comments so employees can correct and resubmit without delay.",
        ],
      },
      {
        id: "manager-approval-rules",
        title: "Approval Rules",
        paragraphs: [
          "If amount is less than or equal to INR 50,000, manager can approve directly.",
          "If amount is greater than INR 50,000, request is sent for admin approval.",
        ],
      },
      {
        id: "manager-status-updates",
        title: "Status Updates",
        paragraphs: [
          "After manager action, expense status updates immediately in the workflow.",
          "Employees can track latest status in their dashboard.",
        ],
      },
      {
        id: "manager-review-checklist",
        title: "Manager Review Checklist",
        paragraphs: [
          "Check amount reasonability against trip purpose and category.",
          "Confirm receipt quality (readable amount/date/vendor) before verification.",
          "Escalate policy exceptions to admin instead of force-approving unclear claims.",
        ],
      },
    ],
  },
  employee: {
    role: "employee",
    displayName: "Employee Guide",
    summary: "Add, submit, and track your expenses from dashboard to final approval.",
    lastUpdated: "May 2026",
    quickLinks: [
      { label: "My Expenses", route: "/expenses" },
      { label: "Create Expense", route: "/expenses/new" },
      { label: "Notifications", route: "/notifications" },
    ],
    sections: [
      {
        id: "employee-getting-started",
        title: "Step 1: Login to PesoWise",
        paragraphs: [
          "Open PesoWise and enter your login credentials.",
          "Once logged in, you will land on the dashboard.",
        ],
      },
      {
        id: "employee-my-expenses",
        title: "Step 2: Go to My Expenses",
        paragraphs: [
          "From the left sidebar, click My Expenses.",
          "This section shows all your submitted expenses.",
        ],
      },
      {
        id: "employee-add-expense",
        title: "Step 3: Add a New Expense",
        paragraphs: [
          "Click Add Expense to open the expense form.",
        ],
      },
      {
        id: "employee-fill-details",
        title: "Step 4: Fill in Expense Details",
        paragraphs: [
          "Enter category (for example, Airfare), title (for example, Business Meeting Travel), location, and total amount.",
          "Upload the receipt or supporting proof before submitting.",
          "Make sure amount entered in the form matches the receipt total.",
        ],
      },
      {
        id: "employee-submit-expense",
        title: "Step 5: Submit Expense",
        paragraphs: [
          "After filling all required fields, click Submit.",
          "Your expense is recorded in the system.",
        ],
      },
      {
        id: "employee-track-status",
        title: "Step 6: View Your Expenses",
        paragraphs: [
          "Return to My Expenses to see your submitted entries.",
          "Track status updates as Pending / Approved / Rejected.",
        ],
      },
      {
        id: "employee-best-practices",
        title: "Good Practices",
        paragraphs: [
          "Upload clear receipts and use descriptive titles so manager/admin can review faster.",
          "Check notifications regularly for remarks or action needed on rejected expenses.",
          "Submit expenses early to avoid period-end approval delays.",
          "If rejected, edit the same expense with corrected details and resubmit promptly.",
        ],
      },
    ],
  },
};
