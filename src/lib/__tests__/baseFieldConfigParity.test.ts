/**
 * Base field config parity — T23–T25, T33
 *
 * Pure logic tests (no React rendering). Verifies that the resolver chain
 * preserves custom labels and field_key values end-to-end.
 */

import { describe, it, expect } from "vitest";
import {
  resolveBaseFieldConfig,
  DEFAULT_BASE_FIELD_CONFIG,
  type BaseExpenseFieldKey,
} from "@/lib/expenseFormConfig";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";

const mockT = (key: string) => `TRANSLATED_${key}`;

function makeCustomRows(overrides: { field_key: string; label: string }[]) {
  return overrides.map(({ field_key, label }) => ({
    field_key,
    label,
    is_required: false,
    is_visible: true,
  }));
}

describe("T23 — 'Purpose / Title' custom label flows through resolver chain", () => {
  it("resolveBaseFieldConfig + translateBaseFieldConfig preserves 'Purpose / Title'", () => {
    const rows = makeCustomRows([{ field_key: "title", label: "Purpose / Title" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(cfg, mockT as any);
    expect(translated.title.label).toBe("Purpose / Title");
  });
});

describe("T24 — 'Remark' custom purpose label flows through resolver chain", () => {
  it("resolveBaseFieldConfig + translateBaseFieldConfig preserves 'Remark'", () => {
    const rows = makeCustomRows([{ field_key: "purpose", label: "Remark" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(cfg, mockT as any);
    expect(translated.purpose.label).toBe("Remark");
  });
});

describe("T25 — Default config produces non-null labels for all base fields", () => {
  it("all base fields in DEFAULT_BASE_FIELD_CONFIG have truthy label", () => {
    const keys: BaseExpenseFieldKey[] = ["title", "category", "purpose", "amount", "destination", "expense_date"];
    for (const key of keys) {
      expect(DEFAULT_BASE_FIELD_CONFIG[key].label).toBeTruthy();
    }
  });
});

describe("T33 — canonical field_key values are never renamed by resolve+translate chain", () => {
  it("all field_key values remain the canonical DB key strings", () => {
    const rows = makeCustomRows([
      { field_key: "title", label: "Purpose / Title" },
      { field_key: "purpose", label: "Remark" },
      { field_key: "category", label: "Expense Type" },
      { field_key: "amount", label: "Cost" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(cfg, mockT as any);

    expect(translated.title.field_key).toBe("title");
    expect(translated.purpose.field_key).toBe("purpose");
    expect(translated.category.field_key).toBe("category");
    expect(translated.amount.field_key).toBe("amount");
    expect(translated.destination.field_key).toBe("destination");
  });
});
