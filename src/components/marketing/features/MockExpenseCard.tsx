import { FileText, Calendar, MapPin, Receipt } from "lucide-react";

export function MockExpenseCard() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <FileText className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Office Supplies</p>
            <p className="text-xs text-muted-foreground">ABC Hardware Store</p>
          </div>
        </div>
        <span className="rounded-full bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning">
          Pending
        </span>
      </div>
      <div className="space-y-2 mb-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Calendar className="h-3.5 w-3.5" />
          Feb 4, 2026
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <MapPin className="h-3.5 w-3.5" />
          Main Office
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" />
          receipt_001.pdf
        </div>
      </div>
      <div className="pt-3 border-t border-border flex justify-between items-end">
        <span className="text-xs text-muted-foreground">Amount</span>
        <span className="text-lg font-bold text-foreground">₹ 2,450.00</span>
      </div>
    </div>
  );
}
