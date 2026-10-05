/**
 * Synthetic data for the public interactive product previews.
 *
 * Everything here is fictional. No customer, employee or organization data
 * exists in this file, and none of the marketing previews may import the
 * authenticated app (AuthContext, the Supabase client, report/dashboard RPC
 * helpers). They are presentational, local-state demos only.
 */

/** ₹1,28,450 (Indian digit grouping), whole rupees. */
export function formatDemoINR(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}₹${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────
export type DashboardPeriodId = "all" | "2026-09" | "2026-08" | "2026-07";

export interface DashboardPeriod {
  id: DashboardPeriodId;
  label: string;
  balance: number;
  /** Wording that makes the balance's meaning explicit (live vs month-end). */
  balanceLabel: string;
  totalExpenses: number;
  pending: number;
  pendingLabel: string;
  /** Relative bar heights (0-100) for the tiny activity chart. */
  bars: number[];
  activity: { title: string; date: string; amount: number }[];
}

export const DASHBOARD_PERIODS: DashboardPeriod[] = [
  {
    id: "all",
    label: "All time",
    balance: 128450,
    balanceLabel: "Available balance",
    totalExpenses: 482600,
    pending: 36240,
    pendingLabel: "Awaiting approval",
    bars: [38, 52, 44, 61, 70, 58, 82],
    activity: [
      { title: "Site consumables", date: "18 Sep 2026", amount: 4200 },
      { title: "Fuel · North Plant", date: "16 Sep 2026", amount: 4850 },
      { title: "Client visit travel", date: "12 Sep 2026", amount: 2600 },
    ],
  },
  {
    id: "2026-09",
    label: "September 2026",
    balance: 128450,
    balanceLabel: "Balance as of today",
    totalExpenses: 58220,
    pending: 9420,
    pendingLabel: "Pending in September 2026",
    bars: [22, 35, 48, 41, 63, 57, 74],
    activity: [
      { title: "Site consumables", date: "18 Sep 2026", amount: 4200 },
      { title: "Fuel · North Plant", date: "16 Sep 2026", amount: 4850 },
      { title: "Client visit travel", date: "12 Sep 2026", amount: 2600 },
    ],
  },
  {
    id: "2026-08",
    label: "August 2026",
    balance: 94820,
    balanceLabel: "Balance as of 31 Aug 2026",
    totalExpenses: 82430,
    pending: 12600,
    pendingLabel: "Pending in August 2026",
    bars: [55, 64, 49, 72, 81, 66, 90],
    activity: [
      { title: "Office setup fittings", date: "28 Aug 2026", amount: 12450 },
      { title: "Fuel · Field Ops West", date: "21 Aug 2026", amount: 3900 },
      { title: "Site consumables", date: "09 Aug 2026", amount: 5150 },
    ],
  },
  {
    id: "2026-07",
    label: "July 2026",
    balance: 71300,
    balanceLabel: "Balance as of 31 Jul 2026",
    totalExpenses: 76210,
    pending: 4800,
    pendingLabel: "Pending in July 2026",
    bars: [40, 46, 58, 51, 67, 60, 63],
    activity: [
      { title: "Ahmedabad Office rent share", date: "30 Jul 2026", amount: 15000 },
      { title: "Field survey travel", date: "17 Jul 2026", amount: 3100 },
      { title: "Fuel · North Plant", date: "05 Jul 2026", amount: 4400 },
    ],
  },
];

// ── Expense form ─────────────────────────────────────────────────────────────
export type DemoCategory = "Travel" | "Fuel" | "Site Purchase" | "Office Expense";
export const DEMO_CATEGORIES: DemoCategory[] = ["Travel", "Fuel", "Site Purchase", "Office Expense"];

export const RECENT_LOCATIONS = ["Ahmedabad Office", "Sanand Plant", "Vadodara Site"];

export interface DemoProject {
  uniqueId: string;
  projectId: string;
  name: string;
}
export const DEMO_PROJECTS: DemoProject[] = [
  { uniqueId: "PRJ-2026-014", projectId: "1042", name: "North Plant Upgrade" },
  { uniqueId: "PRJ-2026-021", projectId: "1057", name: "Ahmedabad Office Setup" },
  { uniqueId: "PRJ-2026-033", projectId: "1071", name: "Field Operations West" },
];

export const DEMO_DEPARTMENTS = ["Operations", "Finance", "Administration"];
export const DEMO_TRAVEL_TYPES = ["Project Visit", "Client Meeting"] as const;
export const DEMO_CLIENTS = ["Northwind Traders", "Harbor Logistics"];

// ── Report preview ───────────────────────────────────────────────────────────
export type ExpenseType = "Travel" | "Fuel" | "Site Purchase" | "Office Expense";

export interface DemoReportRow {
  employee: string;
  employeeId: string;
  /** ISO date */
  date: string;
  txn: string;
  title: string;
  type: "Expense Deduction";
  expenseType: ExpenseType;
  projectId: string;
  projectName: string;
  debit: number;
  opening: number;
  closing: number;
}

const EMPLOYEES = [
  { name: "Aarav Shah", id: "EMP-101", start: 42000 },
  { name: "Riya Mehta", id: "EMP-102", start: 36000 },
  { name: "Kabir Patel", id: "EMP-103", start: 51000 },
];
const PROJECT_BY_NAME = Object.fromEntries(DEMO_PROJECTS.map((p) => [p.name, p.projectId]));

// [employee index, date, title, expense type, project name, debit]
const RAW: [number, string, string, ExpenseType, string, number][] = [
  [0, "2026-08-04", "Fuel refill", "Fuel", "North Plant Upgrade", 3200],
  [0, "2026-08-11", "Site cables", "Site Purchase", "North Plant Upgrade", 8450],
  [0, "2026-08-25", "Visit to plant", "Travel", "Field Operations West", 1800],
  [0, "2026-09-03", "Fuel refill", "Fuel", "Field Operations West", 2900],
  [0, "2026-09-16", "Printer toner", "Office Expense", "Ahmedabad Office Setup", 1250],
  [1, "2026-08-06", "Client visit cab", "Travel", "Ahmedabad Office Setup", 2200],
  [1, "2026-08-14", "Desk fittings", "Site Purchase", "Ahmedabad Office Setup", 6400],
  [1, "2026-08-27", "Stationery", "Office Expense", "Ahmedabad Office Setup", 980],
  [1, "2026-09-02", "Fuel refill", "Fuel", "North Plant Upgrade", 4850],
  [1, "2026-09-09", "Site survey travel", "Travel", "North Plant Upgrade", 2600],
  [1, "2026-09-17", "Safety gear", "Site Purchase", "North Plant Upgrade", 5300],
  [1, "2026-09-24", "Fuel refill", "Fuel", "Field Operations West", 3100],
  [2, "2026-08-05", "Fuel refill", "Fuel", "Field Operations West", 3500],
  [2, "2026-08-19", "Pump spares", "Site Purchase", "Field Operations West", 9200],
  [2, "2026-08-28", "Team travel", "Travel", "North Plant Upgrade", 4100],
  [2, "2026-09-05", "Housekeeping supplies", "Office Expense", "Ahmedabad Office Setup", 1450],
  [2, "2026-09-12", "Fuel refill", "Fuel", "North Plant Upgrade", 3300],
];

function buildRows(): DemoReportRow[] {
  const rows: DemoReportRow[] = [];
  let txn = 1201;
  for (let e = 0; e < EMPLOYEES.length; e += 1) {
    let balance = EMPLOYEES[e].start;
    const mine = RAW.filter((r) => r[0] === e).sort((a, b) => a[1].localeCompare(b[1]));
    for (const [, date, title, expenseType, projectName, debit] of mine) {
      const opening = balance;
      balance -= debit;
      rows.push({
        employee: EMPLOYEES[e].name,
        employeeId: EMPLOYEES[e].id,
        date,
        txn: String(txn),
        title,
        type: "Expense Deduction",
        expenseType,
        projectId: PROJECT_BY_NAME[projectName],
        projectName,
        debit,
        opening,
        closing: balance,
      });
      txn += 1;
    }
  }
  return rows;
}

export const DEMO_ALL_ROWS: DemoReportRow[] = buildRows();

export interface DemoReport {
  id: string;
  filename: string;
  title: string;
  scope: string;
  rows: DemoReportRow[];
}

const inRange = (from: string, to: string) => (r: DemoReportRow) => r.date >= from && r.date <= to;

export const DEMO_REPORTS: DemoReport[] = [
  {
    id: "aug-all",
    filename: "All-Employees_01-08-2026_to_31-08-2026.csv",
    title: "August 2026 · All employees",
    scope: "Expense Type: All",
    rows: DEMO_ALL_ROWS.filter(inRange("2026-08-01", "2026-08-31")),
  },
  {
    id: "sep-riya",
    filename: "Riya-Mehta_01-09-2026_to_30-09-2026.csv",
    title: "September 2026 · Riya Mehta",
    scope: "Employee: Riya Mehta",
    rows: DEMO_ALL_ROWS.filter((r) => r.employee === "Riya Mehta").filter(inRange("2026-09-01", "2026-09-30")),
  },
  {
    id: "sep-fuel",
    filename: "All-Employees_01-09-2026_to_30-09-2026_Fuel.csv",
    title: "September 2026 · Fuel only",
    scope: "Expense Type: Fuel",
    rows: DEMO_ALL_ROWS.filter((r) => r.expenseType === "Fuel").filter(inRange("2026-09-01", "2026-09-30")),
  },
];

export const CSV_HEADERS = [
  "Employee",
  "Employee ID",
  "Date",
  "Transaction #",
  "Title",
  "Type",
  "Expense Type",
  "Project ID",
  "Project Name",
  "Debit",
  "Opening Balance",
  "Closing Balance",
] as const;

export function formatDemoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

/** Synthetic CSV for the demo Download button (no real data, generated locally). */
export function buildDemoCsv(rows: DemoReportRow[]): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [r.employee, r.employeeId, formatDemoDate(r.date), r.txn, r.title, r.type, r.expenseType, r.projectId, r.projectName, r.debit, r.opening, r.closing]
        .map(esc)
        .join(","),
    );
  }
  return lines.join("\n");
}

// ── Balance transfer ─────────────────────────────────────────────────────────
export const TRANSFER_RECIPIENTS = [
  { name: "Riya Mehta", balance: 12500 },
  { name: "Aarav Shah", balance: 8400 },
  { name: "Kabir Patel", balance: 15200 },
];
export const TRANSFER_AMOUNTS = [10000, 20000, 50000];
export const ADMIN_START_BALANCE = 150000;

// ── Approval workflow ────────────────────────────────────────────────────────
export const APPROVAL_STAGES = [
  { id: "submitted", label: "Submitted", actor: "Aarav Shah", note: "Expense and receipts submitted" },
  { id: "team-leader", label: "Team Leader", actor: "Team Leader", note: "Reviewed and forwarded" },
  { id: "engineer", label: "Engineer Review", actor: "Site Engineer", note: "Verified against the site purchase" },
  { id: "executive", label: "Executive", actor: "Executive (optional)", note: "Optional tier, when configured" },
  { id: "admin", label: "Admin Approval", actor: "Admin", note: "Final approval" },
] as const;
export const APPROVAL_AMOUNT = 8450;
export const APPROVAL_START_BALANCE = 42000;

// ── My Teams ─────────────────────────────────────────────────────────────────
export const DEMO_TEAMS = [
  {
    id: "a",
    name: "Team A · Site Operations",
    members: [
      { name: "Aarav Shah", pending: 2, approved: 9 },
      { name: "Kabir Patel", pending: 1, approved: 7 },
      { name: "Nisha Rao", pending: 0, approved: 5 },
    ],
  },
  {
    id: "b",
    name: "Team B · Office & Admin",
    members: [
      { name: "Riya Mehta", pending: 3, approved: 11 },
      { name: "Dev Joshi", pending: 1, approved: 4 },
    ],
  },
];
