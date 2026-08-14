import { Receipt } from "lucide-react";

/* macOS-style window controls */
function WindowControls() {
  return (
    <div className="flex items-center gap-1.5 absolute top-4 left-4">
      <span className="w-3 h-3 rounded-full bg-[#ff5f57]" />
      <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
      <span className="w-3 h-3 rounded-full bg-[#28c840]" />
    </div>
  );
}

const summaryCards = [
  {
    title: "Available Balance",
    value: "₹ 45,230.00",
    detail: "+12.5% this month",
    detailClass: "text-success",
    dot: "bg-success",
  },
  {
    title: "Pending Approval",
    value: "₹ 8,450.00",
    detail: "5 expense reports",
    detailClass: "text-warning",
    dot: null,
  },
  {
    title: "Spent This Month",
    value: "₹ 23,680.00",
    progress: 78,
    dot: null,
  },
];

const recentExpenses = [
  { name: "Office Supplies", time: "Today, 2:30 PM", amount: "₹ 1,250.00" },
  { name: "Team Lunch", time: "Today, 2:30 PM", amount: "₹ 2,100.00" },
  { name: "Travel Fare", time: "Today, 2:30 PM", amount: "₹ 850.00" },
];

export function MockDashboardLarge() {
  return (
    <div className="relative rounded-2xl border border-border bg-card shadow-soft max-w-lg w-full overflow-hidden">
      <WindowControls />
      <div className="p-6 pt-10">
        {/* Top row – summary cards */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          {summaryCards.map((card, i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-muted/50 p-4 shadow-sm"
            >
              <p className="text-xs text-muted-foreground mb-1">{card.title}</p>
              <p className="text-base font-bold text-foreground truncate">{card.value}</p>
              {card.detail && (
                <p className={`text-xs mt-1 flex items-center gap-1 ${card.detailClass}`}>
                  {card.dot && <span className={`w-1.5 h-1.5 rounded-full ${card.dot}`} />}
                  {card.detail}
                </p>
              )}
              {card.progress != null && (
                <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${card.progress}%` }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Recent Expenses */}
        <h3 className="text-sm font-semibold text-foreground mb-3">Recent Expenses</h3>
        <div className="space-y-2">
          {recentExpenses.map((row, i) => (
            <div
              key={i}
              className="flex items-center gap-3 p-3 rounded-xl border border-border bg-muted/30 shadow-sm"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                <Receipt className="h-4 w-4 text-warning" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">{row.name}</p>
                <p className="text-xs text-muted-foreground">{row.time}</p>
              </div>
              <p className="text-sm font-semibold text-foreground tabular-nums">{row.amount}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
