import { describe, expect, it } from "vitest";
import { autoMapRules, changedLedgers, DEFAULT_PWT_CATEGORIES, sharedLedgers, suggestLedger } from "../pwtSync";

describe("auto mapping", () => {
  it("suggests the standard ledger from the expense type name", () => {
    expect(suggestLedger("Hotel Stay")).toBe("Lodging Expenses");
    expect(suggestLedger("Fuel")).toBe("Conveyance Expenses");
    expect(suggestLedger("Mobile Recharge")).toBe("Telephone Expenses");
    expect(suggestLedger("Something odd")).toBe("Miscellaneous Expenses");
  });
  it("adds only unmapped types, with the next free number (never 99), and keeps existing rows", () => {
    const r = autoMapRules(DEFAULT_PWT_CATEGORIES, ["Food", "Hotel/Guest House", "Courier Charges", "Parking"]);
    expect(r.added).toBe(2);
    expect(r.rules.filter((x) => x.serial === 99)).toHaveLength(1);
    expect(r.rules.find((x) => x.expenseType === "Courier Charges")).toMatchObject({ serial: 11, expenseLedger: "Site Expenses" });
    expect(r.rules.find((x) => x.expenseType === "Parking")).toMatchObject({ serial: 12, expenseLedger: "Miscellaneous Expenses" });
  });
  it("fills a blank ledger", () => {
    const r = autoMapRules([{ serial: 1, expenseType: "Petrol", expenseLedger: "" }], []);
    expect(r.filled).toBe(1);
    expect(r.rules[0].expenseLedger).toBe("Conveyance Expenses");
  });
  it("reports ledgers that several expense types share", () => {
    const rules = DEFAULT_PWT_CATEGORIES.map((x) => (x.expenseType === "Incentive" ? { ...x, expenseLedger: "Miscellaneous Expenses" } : x));
    const s = sharedLedgers(rules);
    expect(s.map((x) => x.ledger).sort()).toEqual(["Miscellaneous Expenses", "Travelling Expenses"]);
  });
});

describe("changed ledgers", () => {
  it("lists only saved types whose ledger was changed (new rows are not changes)", () => {
    const now = [...DEFAULT_PWT_CATEGORIES.map((r) => (r.expenseType === "Incentive" ? { ...r, expenseLedger: "Miscellaneous Expenses" } : r)), { serial: 11, expenseType: "New", expenseLedger: "Site Expenses" }];
    expect(changedLedgers(DEFAULT_PWT_CATEGORIES, now)).toEqual(["Incentive"]);
  });
});

import { changedSerials, withNaRow } from "../pwtSync";
describe("number changes and N/A", () => {
  it("lists saved types whose voucher number changed", () => {
    const now = DEFAULT_PWT_CATEGORIES.map((r) => (r.expenseType === "Food" ? { ...r, serial: 20 } : r));
    expect(changedSerials(DEFAULT_PWT_CATEGORIES, now)).toEqual(["Food"]);
  });
  it("keeps N/A on its fixed number 99", () => {
    const rules = [...DEFAULT_PWT_CATEGORIES.filter((r) => r.serial !== 99), { serial: 11, expenseType: "N/A", expenseLedger: "Miscellaneous Expenses" }];
    expect(withNaRow(rules).find((r) => r.expenseType === "N/A")?.serial).toBe(99);
  });
});
