import { formatINR } from "@/lib/format";

type BalanceRow = {
  id: string;
  date: string;
  type: "allocation" | "expense";
  credit: number;
  debit: number;
  notes: string;
  category: string;
  title: string;
  closingBalance: number;
};

type AllEmployeesRow = {
  id: string;
  user_name: string;
  trip_start: string;
  title: string | null;
  category: string | null;
  total_amount: number | null;
};

interface MobileDetailedExpenseReportViewProps {
  showDetailedBalanceColumns: boolean;
  loading: boolean;
  detailedCustomFilterHasNoData: boolean;
  balanceInfo: { opening: number };
  detailedListWithBalances: BalanceRow[];
  detailedAllEmployeesRows: AllEmployeesRow[];
}

function fmtDate(d: string | null): string {
  if (!d) return "-";
  try {
    const dt = new Date(d);
    const day = String(dt.getDate()).padStart(2, "0");
    const month = String(dt.getMonth() + 1).padStart(2, "0");
    const year = dt.getFullYear();
    return `${day}-${month}-${year}`;
  } catch {
    return "-";
  }
}

export function MobileDetailedExpenseReportView({
  showDetailedBalanceColumns,
  loading,
  detailedCustomFilterHasNoData,
  balanceInfo,
  detailedListWithBalances,
  detailedAllEmployeesRows,
}: MobileDetailedExpenseReportViewProps) {
  if (loading) {
    return (
      <div className="py-8 text-center text-slate-500 text-sm">Loading...</div>
    );
  }

  if (showDetailedBalanceColumns) {
    if (detailedListWithBalances.length === 0) {
      return (
        <div className="py-6 text-center text-slate-500 text-sm px-4">
          {detailedCustomFilterHasNoData
            ? "No approved expenses for this employee with the selected custom field value (red options have no data)."
            : "No allocations or expenses in this period. Click Submit after choosing filters."}
        </div>
      );
    }

    const lastRow = detailedListWithBalances[detailedListWithBalances.length - 1];

    return (
      <div className="space-y-2" data-testid="detailed-card-list">
        <div
          className="rounded-md bg-slate-50 border px-3 py-2 text-xs text-slate-600"
          data-testid="opening-balance-banner"
        >
          Opening Balance: {formatINR(balanceInfo.opening)}
        </div>
        {detailedListWithBalances.map((row) => (
          <div
            key={row.id}
            className="rounded-md border p-3 space-y-1"
            data-testid="detailed-balance-card"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">{fmtDate(row.date)}</span>
              <span className={`text-sm font-medium ${row.credit > 0 ? "text-green-600" : ""}`}>
                {row.credit > 0
                  ? `+${formatINR(row.credit)}`
                  : `-${formatINR(row.debit)}`}
              </span>
            </div>
            <div className="text-xs truncate">
              {row.type === "expense" ? row.title || "-" : row.notes} · {row.category}
            </div>
            <div className="text-xs text-muted-foreground">
              Closing: {formatINR(row.closingBalance)}
            </div>
          </div>
        ))}
        <div className="rounded-md bg-slate-50 border px-3 py-2 text-xs text-slate-600">
          Closing Balance: {formatINR(lastRow.closingBalance)}
        </div>
      </div>
    );
  }

  if (detailedAllEmployeesRows.length === 0) {
    return (
      <div className="py-6 text-center text-slate-500 text-sm px-4">
        No approved expenses match your filters. Click Submit to refresh, or widen year/month/category.
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="detailed-card-list">
      {detailedAllEmployeesRows.map((exp) => (
        <div
          key={exp.id}
          className="rounded-md border p-3 space-y-1"
          data-testid="detailed-expense-card"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-sm truncate">{exp.user_name}</span>
            <span className="text-sm font-medium shrink-0">
              {formatINR(Number(exp.total_amount || 0))}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {fmtDate(exp.trip_start)} · {exp.category ?? "-"}
          </div>
          <div className="text-xs truncate">{exp.title || "-"}</div>
        </div>
      ))}
    </div>
  );
}
