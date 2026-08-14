import { describe, it, expect } from "vitest";
import { DEFAULT_BASE_FIELD_CONFIG, resolveBaseFieldConfig, slugifyFieldKey } from "@/lib/expenseFormConfig";

describe("expenseFormConfig", () => {
  it("merges org overrides with defaults", () => {
    const resolved = resolveBaseFieldConfig([
      { field_key: "title", label: "Expense Title", is_required: false },
      { field_key: "purpose", is_visible: false },
    ]);

    expect(resolved.title.label).toBe("Expense Title");
    expect(resolved.title.is_required).toBe(false);
    expect(resolved.purpose.is_visible).toBe(false);
    expect(resolved.amount.label).toBe(DEFAULT_BASE_FIELD_CONFIG.amount.label);
  });

  it("slugifies field keys for imports", () => {
    expect(slugifyFieldKey("Odometer Reading (KM)")).toBe("odometer_reading_km");
    expect(slugifyFieldKey("  A  B  ")).toBe("a_b");
  });
});
