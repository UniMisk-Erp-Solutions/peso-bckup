import { History, CheckCircle, FileText, Wallet, User } from "lucide-react";

const entries = [
  { icon: CheckCircle, action: "Expense Approved", actor: "Admin User", time: "2 min ago", iconClass: "text-accent" },
  { icon: FileText, action: "Receipt Uploaded", actor: "Maria Santos", time: "15 min ago", iconClass: "text-primary" },
  { icon: Wallet, action: "Balance Transfer", actor: "Finance Lead", time: "1 hour ago", iconClass: "text-info" },
];

export function MockAuditLog() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Audit Trail
          </p>
        </div>
        <span className="text-[10px] text-muted-foreground">Live</span>
      </div>
      <div className="space-y-3">
        {entries.map((e, i) => {
          const Icon = e.icon;
          return (
            <div key={i} className="flex items-start gap-3 p-2.5 rounded-lg bg-muted/20">
              <Icon className={`h-4 w-4 shrink-0 mt-0.5 ${e.iconClass}`} />
              <div>
                <p className="text-sm font-medium text-foreground">{e.action}</p>
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <User className="h-3 w-3" /> {e.actor} • {e.time}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-border text-center">
        <p className="text-[10px] text-muted-foreground">Exportable for compliance</p>
      </div>
    </div>
  );
}
