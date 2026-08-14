import { Building2, Users } from "lucide-react";

const orgs = [
  { name: "Main Office", users: 12, balance: "₹ 250,000" },
  { name: "Branch A", users: 8, balance: "₹ 75,000" },
  { name: "Branch B", users: 5, balance: "₹ 45,000" },
];

export function MockOrgChart() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <div className="flex justify-between items-center mb-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Organizations
        </p>
        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
          3 Active
        </span>
      </div>
      <div className="space-y-3">
        {orgs.map((org, i) => (
          <div
            key={i}
            className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="h-4 w-4 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{org.name}</p>
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {org.users} users
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="text-sm font-semibold text-foreground">{org.balance}</p>
              <p className="text-[10px] text-muted-foreground">Balance</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
