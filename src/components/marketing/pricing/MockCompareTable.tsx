import { Link } from "react-router-dom";
import { Check, X } from "lucide-react";

type CellValue = boolean | string;

const PLANS = ["Starter", "Growth", "Enterprise"] as const;
const GROWTH_INDEX = 1;

const compareRows: { feature: string; starter: CellValue; growth: CellValue; enterprise: CellValue }[] = [
  { feature: "Users", starter: "Up to 5", growth: "Up to 25", enterprise: "Unlimited" },
  { feature: "Expense Reports", starter: true, growth: true, enterprise: true },
  { feature: "Receipt Upload", starter: true, growth: true, enterprise: true },
  { feature: "Approval Workflow", starter: "Basic", growth: "Advanced", enterprise: "Custom" },
  { feature: "Configurable Expense Forms", starter: false, growth: true, enterprise: true },
  { feature: "Hierarchy Approvals", starter: false, growth: true, enterprise: true },
  { feature: "My Teams", starter: false, growth: true, enterprise: true },
  { feature: "Engineer Verification", starter: false, growth: true, enterprise: true },
  { feature: "Batch Expense Entry", starter: false, growth: true, enterprise: true },
  { feature: "Transfer Offers", starter: false, growth: true, enterprise: true },
  { feature: "Balance Management", starter: true, growth: true, enterprise: true },
  { feature: "Multi-Organization", starter: false, growth: true, enterprise: true },
  { feature: "Project & Custom Field Filters", starter: false, growth: true, enterprise: true },
  { feature: "Dashboards & Reporting", starter: "Basic", growth: "Advanced", enterprise: "Custom" },
  { feature: "CSV Export", starter: false, growth: true, enterprise: true },
  { feature: "Employee ID Login", starter: false, growth: false, enterprise: true },
  { feature: "Priority Support", starter: false, growth: true, enterprise: true },
  { feature: "Dedicated Support & SLA", starter: false, growth: false, enterprise: true },
];

function CellContent({ value }: { value: CellValue }) {
  if (value === true) return <Check className="h-4 w-4 text-accent mx-auto" />;
  if (value === false) return <X className="h-4 w-4 text-muted-foreground/50 mx-auto" />;
  return <span className="text-xs text-foreground">{value}</span>;
}

export function MockCompareTable() {
  return (
    <div className="min-w-[min(100%,28rem)] sm:min-w-[32rem] rounded-xl border border-border bg-card overflow-hidden">
      <div className="grid grid-cols-4 border-b border-border bg-muted/30">
        <div className="p-4">
          <span className="text-xs font-medium text-muted-foreground">Compare Plans</span>
        </div>
        {PLANS.map((plan, i) => (
          <div
            key={plan}
            className={`p-4 text-center ${i === GROWTH_INDEX ? "bg-primary/5" : ""}`}
          >
            {i === GROWTH_INDEX && (
              <span className="inline-block rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground mb-1">
                Most Popular
              </span>
            )}
            <p className={`text-sm font-semibold ${i === GROWTH_INDEX ? "text-primary" : "text-foreground"}`}>
              {plan}
            </p>
          </div>
        ))}
      </div>
      <div className="divide-y divide-border">
        {compareRows.map((row, i) => (
          <div key={i} className="grid grid-cols-4">
            <div className="p-3 flex items-center">
              <span className="text-xs text-muted-foreground">{row.feature}</span>
            </div>
            <div className="p-3 flex items-center justify-center">
              <CellContent value={row.starter} />
            </div>
            <div className="p-3 flex items-center justify-center bg-primary/5">
              <CellContent value={row.growth} />
            </div>
            <div className="p-3 flex items-center justify-center">
              <CellContent value={row.enterprise} />
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-4 border-t border-border bg-muted/30">
        <div className="p-4" />
        <div className="p-4 text-center">
          <Link
            to="/contact"
            className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted w-full"
          >
            Contact Us
          </Link>
        </div>
        <div className="p-4 text-center bg-primary/5">
          <Link
            to="/contact"
            className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground w-full"
          >
            Contact Us
          </Link>
        </div>
        <div className="p-4 text-center">
          <Link
            to="/contact"
            className="inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-xs font-medium text-foreground hover:bg-muted w-full"
          >
            Contact Us
          </Link>
        </div>
      </div>
    </div>
  );
}
