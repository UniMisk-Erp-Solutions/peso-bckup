import type { DeliveryAction } from "./types";

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
}
