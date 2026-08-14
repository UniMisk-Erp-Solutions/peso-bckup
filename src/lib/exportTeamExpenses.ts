import { formatINR } from "@/lib/format";
import type { TeamExpenseRow } from "@/services/MyTeamsService";

function escapeCsvCell(value: string | number): string {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildTeamExpensesCsv(
  teamName: string,
  rows: TeamExpenseRow[],
): string {
  const headers = [
    "Team",
    "Employee Name",
    "Employee ID",
    "Email",
    "Title",
    "Amount",
    "Status",
    "Date",
    "Category",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        teamName,
        row.employee_name,
        row.employee_id,
        row.employee_email,
        row.title,
        row.total_amount,
        row.status,
        row.created_at,
        row.category_name,
      ]
        .map(escapeCsvCell)
        .join(","),
    ),
  ];
  return lines.join("\n");
}

export function downloadTeamExpensesCsv(teamName: string, rows: TeamExpenseRow[]): void {
  const csv = buildTeamExpensesCsv(teamName, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const safeName = teamName.replace(/[^\w\-]+/g, "_").slice(0, 40);
  const link = document.createElement("a");
  link.href = url;
  link.download = `team-expenses-${safeName}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function formatTeamExpenseAmount(amount: number): string {
  return formatINR(Number(amount ?? 0));
}
