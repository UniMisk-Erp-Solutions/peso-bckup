import type { ExpenseCategoryRule, PwtAccountingConfig } from "./types.ts";

/**
 * An expense with an EMPTY category is treated as "N/A" and posted to this ledger instead of being left out. Serial 99 keeps its Voucher ID
 * (PESO/MM/99) clear of the numbered categories. The accountant can change the ledger on the Ledger mapping tab.
 */
export const NA_CATEGORY: ExpenseCategoryRule = { serial: 99, expenseType: "N/A", expenseLedger: "Miscellaneous Expenses", aliases: ["na", "none", "-"] };

/** Adds the N/A rule to a saved mapping that predates it (never overrides a rule the organisation already has for N/A). */
export function withNaRule(cfg: PwtAccountingConfig): PwtAccountingConfig {
  const has = (cfg.categories ?? []).some((c) => [c.expenseType, ...(c.aliases ?? [])].some((n) => n.trim().toLowerCase() === "n/a"));
  const serialTaken = (cfg.categories ?? []).some((c) => c.serial === NA_CATEGORY.serial);
  if (has || serialTaken) return cfg;
  return { ...cfg, categories: [...cfg.categories, NA_CATEGORY] };
}

/**
 * Default mapping, taken from the *methodology* of the "Expnese Categories" sheet in the
 * accountant's workbook (expense type -> voucher serial -> Tally expense ledger).
 * No historical records are embedded. Organisations override this in `pwt_mapping_config`.
 */
export const DEFAULT_PWT_CONFIG: PwtAccountingConfig = {
  voucherType: "Journal",
  voucherPrefix: "PESO",
  expenseSide: "debit",
  postingDatePolicy: "month_end",
  employeeLedgerParent: "Sundry Debtors",
  expenseLedgerParent: "Indirect Expenses",
  narrationTag: "PWT",
  reportRowsInTally: false,
  dailyCostCategories: {
    petrol_cost: "Petrol Expense (Bike and Car)",
    material_cost: "Material Purchase",
    travelling_cost: "Travelling (Public and Private Transport)",
    phone_exp: "Mobile Recharges",
    hotel_exp: "Hotel/Guest House",
    food: "Food",
  },
  categories: [
    { serial: 1, expenseType: "Travelling (Public and Private Transport)", expenseLedger: "Travelling Expenses" },
    { serial: 2, expenseType: "Material Purchase", expenseLedger: "Consumable Stores - URD" },
    {
      serial: 3, expenseType: "Other ( Xerox, Printing, Courier, Stationery & Medical )", expenseLedger: "Site Expenses",
      // Spelling variants that exist in PesoWise data; owner-approved to map to the same Other ledger.
      aliases: ["Other ( Xerox, Printing, Courier & Stationery )", "other"],
    },
    { serial: 4, expenseType: "Laptop Rent", expenseLedger: "Rent Expenses - Equipment" },
    { serial: 5, expenseType: "Hotel/Guest House", expenseLedger: "Lodging Expenses" },
    { serial: 6, expenseType: "Petrol Expense (Bike and Car)", expenseLedger: "Conveyance Expenses" },
    { serial: 7, expenseType: "Local Manpower", expenseLedger: "Labour Charges Expenses-URD" },
    { serial: 8, expenseType: "Mobile Recharges", expenseLedger: "Telephone Expenses" },
    { serial: 9, expenseType: "Food", expenseLedger: "Travelling Expenses" },
    { serial: 10, expenseType: "Incentive", expenseLedger: "Incentive Expenses" },
    NA_CATEGORY,
  ],
};
