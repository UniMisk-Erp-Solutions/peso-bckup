import type { PwtAccountingConfig } from "./types.ts";

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
  ],
};
