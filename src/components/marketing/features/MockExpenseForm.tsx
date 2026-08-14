import { useState, useCallback } from "react";
import { CheckCircle } from "lucide-react";

const MESSAGE_DURATION_MS = 6_000;

const CATEGORY_OPTIONS = ["Supplies", "Travel", "Meals", "Utilities", "Other"] as const;

export interface MockExpenseFormData {
  title: string;
  vendor: string;
  amount: string;
  date: string;
  category: string;
}

const DEFAULT_VALUES: MockExpenseFormData = {
  title: "Office Supplies Purchase",
  vendor: "National Bookstore",
  amount: "₹ 1,250.00",
  date: "Jan 15, 2024",
  category: "Supplies",
};

interface MockExpenseFormProps {
  /** When provided, called with form data on submit (e.g. to show in Track Approval) */
  onSubmit?: (data: MockExpenseFormData) => void;
}

export function MockExpenseForm({ onSubmit }: MockExpenseFormProps) {
  const [submitted, setSubmitted] = useState(false);
  const [title, setTitle] = useState(DEFAULT_VALUES.title);
  const [vendor, setVendor] = useState(DEFAULT_VALUES.vendor);
  const [amount, setAmount] = useState(DEFAULT_VALUES.amount);
  const [date, setDate] = useState(DEFAULT_VALUES.date);
  const [category, setCategory] = useState(DEFAULT_VALUES.category);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const data: MockExpenseFormData = { title, vendor, amount, date, category };
      onSubmit?.(data);
      setSubmitted(true);
      const t = setTimeout(() => setSubmitted(false), MESSAGE_DURATION_MS);
      return () => clearTimeout(t);
    },
    [title, vendor, amount, date, category, onSubmit]
  );

  if (submitted) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 shadow-soft max-w-xs text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-12 w-12 rounded-full bg-success/10 flex items-center justify-center">
            <CheckCircle className="h-6 w-6 text-success" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">Submitted!</h3>
          <p className="text-xs text-muted-foreground">
            Your expense is under review. This preview will reset in a few seconds.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-soft max-w-xs">
      <h3 className="text-sm font-semibold text-foreground mb-4">New Expense Report</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. Office Supplies"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Vendor / Destination</label>
          <input
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="e.g. National Bookstore"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Amount</label>
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="₹ 0.00"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Date</label>
            <input
              type="text"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Jan 15, 2024"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring pr-8 appearance-none cursor-pointer"
            style={{
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 8px center",
              backgroundSize: "12px",
            }}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Receipt</label>
          <div className="rounded-lg border border-dashed border-primary/50 bg-primary/5 p-3 flex items-center gap-3">
            <div className="h-8 w-8 rounded bg-primary/10 flex items-center justify-center text-sm">
              📎
            </div>
            <div className="min-w-0">
              <p className="text-xs truncate">receipt_jan15.pdf</p>
              <p className="text-[10px] text-muted-foreground">PDF • 245 KB</p>
            </div>
          </div>
        </div>
        <button
          type="submit"
          className="w-full rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Submit for Review
        </button>
      </form>
    </div>
  );
}
