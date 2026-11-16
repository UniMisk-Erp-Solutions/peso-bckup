import type { DeliveryAction } from "./types.ts";

/** One accounting voucher emission per stable key per mapping run (cross-report safe). */

export class AccountingRegistry {
  private expenseEmitted = new Map<string, "create" | "alter">();
  private balanceEventEmitted = new Map<string, "create" | "alter">();

  planExpenseVoucher(
    accountingKey: string,
    delivery: DeliveryAction,
  ): "create" | "alter" | null {
    if (delivery === "skip" || delivery === "cancel_planned") return null;
    const want: "create" | "alter" = delivery === "create" ? "create" : "alter";
    const prev = this.expenseEmitted.get(accountingKey);
    if (!prev) {
      this.expenseEmitted.set(accountingKey, want);
      return want;
    }
    if (want === "alter" && prev === "create") {
      this.expenseEmitted.set(accountingKey, "alter");
      return "alter";
    }
    return null;
  }

  planBalanceEventVoucher(
    accountingKey: string,
    delivery: DeliveryAction,
  ): "create" | "alter" | null {
    if (delivery === "skip" || delivery === "cancel_planned") return null;
    const want: "create" | "alter" = delivery === "create" ? "create" : "alter";
    if (this.balanceEventEmitted.has(accountingKey)) return null;
    this.balanceEventEmitted.set(accountingKey, want);
    return want;
  }

  totalAccountingVouchers(): number {
    return this.expenseEmitted.size + this.balanceEventEmitted.size;
  }

  toCheckpoint(): {
    expense: Record<string, "create" | "alter">;
    balance: Record<string, "create" | "alter">;
  } {
    return {
      expense: Object.fromEntries(this.expenseEmitted),
      balance: Object.fromEntries(this.balanceEventEmitted),
    };
  }

  static fromCheckpoint(raw: unknown): AccountingRegistry {
    const reg = new AccountingRegistry();
    if (!raw || typeof raw !== "object") return reg;
    const o = raw as { expense?: Record<string, string>; balance?: Record<string, string> };
    for (const [k, v] of Object.entries(o.expense ?? {})) {
      if (v === "create" || v === "alter") reg.expenseEmitted.set(k, v);
    }
    for (const [k, v] of Object.entries(o.balance ?? {})) {
      if (v === "create" || v === "alter") reg.balanceEventEmitted.set(k, v);
    }
    return reg;
  }
}
