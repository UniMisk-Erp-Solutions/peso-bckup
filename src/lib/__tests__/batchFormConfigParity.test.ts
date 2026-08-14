/**
 * Phase 9 + RC — Batch Form Configuration Parity (runtime fix)
 *
 * T1  — resolveBaseFieldConfig merges custom label from DB row
 * T2  — translateBaseFieldConfig replaces DEFAULT label with locale translation
 * T3  — translateBaseFieldConfig preserves custom label unchanged
 * T4  — validateBatchLines: empty title allowed when is_required=false
 * T5  — validateBatchLines: empty title blocked when is_required=true
 * T6  — validateBatchLines: error message uses configured title label
 * T7  — validateBatchLines: title check independent of Zod (no "Title is required" hardcoded)
 * T8  — BatchExpenseLinesTable: titleLabel shown in column header
 * T9  — BatchExpenseLinesTable: categoryLabel shown in column header
 * T10 — BatchExpenseLinesTable: purposeLabel shown in column header
 * T11 — BatchExpenseLinesTable: amountLabel shown in column header
 * T12 — BatchExpenseLinesTable: placeholder uses titleLabel (not required)
 * T13 — BatchExpenseLinesTable: placeholder uses titleLabel with * when required
 * T14 — validateBatchLines: category label uses configured label in error
 * T15 — validateBatchLines: purpose label uses configured label in error
 * T16 — resolveBaseFieldConfig + translateBaseFieldConfig: "Purpose / Title" custom label flows end-to-end
 * T17 — validateBatchLines: "Purpose / Title" label appears in required-title error
 * T18 — BatchExpenseLinesTable: purpose placeholder uses purposeLabel
 * T19 — BatchExpenseLinesTable: destination placeholder uses destinationLabel
 * T20 — BatchExpenseLinesTable: default config ("Title") renders correctly
 * T21 — BatchExpenseLinesTable: destination column header uses destinationLabel (already correct)
 * T22 — resolveBaseFieldConfig: canonical field_key is "title", never renamed
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import {
  resolveBaseFieldConfig,
  DEFAULT_BASE_FIELD_CONFIG,
  type BaseFieldConfig,
  type BaseExpenseFieldKey,
} from "@/lib/expenseFormConfig";
import { translateBaseFieldConfig } from "@/lib/translateBaseFieldConfig";
import { validateBatchLines } from "@/lib/expenseBatchValidation";
import { BatchExpenseLinesTable } from "@/components/BatchExpenseLinesTable";
import type { BatchLineInput } from "@/lib/expenseBatchValidation";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeLine(overrides: Partial<BatchLineInput> = {}): BatchLineInput {
  return {
    clientId: "line-1",
    title: "Some title",
    amount: 100,
    category: "Travel",
    destination: "",
    purpose: "",
    ...overrides,
  };
}

function makeConfig(
  key: BaseExpenseFieldKey,
  overrides: Partial<BaseFieldConfig>,
): Record<BaseExpenseFieldKey, BaseFieldConfig> {
  return {
    ...DEFAULT_BASE_FIELD_CONFIG,
    [key]: { ...DEFAULT_BASE_FIELD_CONFIG[key], ...overrides },
  };
}

// Mock t() that returns "TRANSLATED_<key>" so assertions are clear
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockT = (key: string) => `TRANSLATED_${key}`;

// ═════════════════════════════════════════════════════════════════════════════
// T1–T3  resolveBaseFieldConfig + translateBaseFieldConfig
// ═════════════════════════════════════════════════════════════════════════════

describe("T1 — resolveBaseFieldConfig merges custom label from DB row", () => {
  it("applies custom label from DB over default", () => {
    const rows = [{ field_key: "title", label: "Heading", is_required: true, is_visible: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    expect(cfg.title.label).toBe("Heading");
  });
});

describe("T2 — translateBaseFieldConfig replaces DEFAULT label", () => {
  it("replaces English default 'Title' with t() result", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(DEFAULT_BASE_FIELD_CONFIG, mockT as any);
    expect(translated.title.label).toBe("TRANSLATED_form.fields.title");
  });
});

describe("T3 — translateBaseFieldConfig preserves custom label", () => {
  it("does not replace custom label 'Heading' with t() result", () => {
    const rows = [{ field_key: "title", label: "Heading", is_required: true, is_visible: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(cfg, mockT as any);
    expect(translated.title.label).toBe("Heading");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T4–T7  validateBatchLines — config-aware title validation
// ═════════════════════════════════════════════════════════════════════════════

describe("T4 — validateBatchLines: empty title allowed when is_required=false", () => {
  it("returns ok when title is empty and is_required=false", () => {
    const cfg = makeConfig("title", { is_required: false, is_visible: true });
    const result = validateBatchLines([makeLine({ title: "" }), makeLine({ title: "" })], cfg);
    expect(result.ok).toBe(true);
  });
});

describe("T5 — validateBatchLines: empty title blocked when is_required=true", () => {
  it("returns error when title is empty and is_required=true", () => {
    const cfg = makeConfig("title", { is_required: true, is_visible: true });
    const result = validateBatchLines([makeLine({ title: "" }), makeLine({ title: "" })], cfg);
    expect(result.ok).toBe(false);
  });
});

describe("T6 — validateBatchLines: error message uses configured title label", () => {
  it("error mentions the configured label 'Heading' not hardcoded 'Title'", () => {
    const cfg = makeConfig("title", { label: "Heading", is_required: true, is_visible: true });
    const result = validateBatchLines([makeLine({ title: "" }), makeLine({ title: "" })], cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Heading");
      expect(result.message).not.toContain("Title is required");
    }
  });
});

describe("T7 — validateBatchLines: no hardcoded 'Title is required' message", () => {
  it("when title optional and empty, no 'Title is required' error fires", () => {
    const cfg = makeConfig("title", { is_required: false, is_visible: true });
    const result = validateBatchLines([makeLine({ title: "" }), makeLine({ title: "" })], cfg);
    if (!result.ok) {
      expect(result.message).not.toContain("Title is required");
    }
    expect(result.ok).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T8–T13  BatchExpenseLinesTable — header labels + placeholder
// ═════════════════════════════════════════════════════════════════════════════

const TABLE_BASE_PROPS = {
  lines: [makeLine()] as BatchLineInput[],
  categories: ["Travel"],
  recommendedCategories: [],
  attachmentLimit: 500,
  attachmentMode: "per_line" as const,
  sharedDestination: "",
  // sharedTitle NOT provided → title column visible
  showCategory: true,
  categoryLabel: "Type of Expense",
  categoryRequired: false,
  titleLabel: "Heading",
  titleRequired: false,
  amountLabel: "Cost",
  showPurpose: true,
  purposeLabel: "Business Reason",
  purposeRequired: false,
  showDestination: false,
  destinationLabel: "Vendor",
  getReceiptCount: () => 0,
  onUpdateLine: vi.fn(),
  onDuplicate: vi.fn(),
  onRemove: vi.fn(),
  onReceiptUpload: vi.fn(),
};

describe("T8 — BatchExpenseLinesTable: titleLabel shown in column header", () => {
  it("renders titleLabel prop as column header", () => {
    render(React.createElement(BatchExpenseLinesTable, TABLE_BASE_PROPS));
    expect(screen.getByRole("columnheader", { name: "Heading" })).toBeInTheDocument();
  });
});

describe("T9 — BatchExpenseLinesTable: categoryLabel shown in column header", () => {
  it("renders categoryLabel prop as column header", () => {
    render(React.createElement(BatchExpenseLinesTable, TABLE_BASE_PROPS));
    expect(screen.getByRole("columnheader", { name: "Type of Expense" })).toBeInTheDocument();
  });
});

describe("T10 — BatchExpenseLinesTable: purposeLabel shown in column header", () => {
  it("renders purposeLabel prop as column header", () => {
    render(React.createElement(BatchExpenseLinesTable, TABLE_BASE_PROPS));
    expect(screen.getByRole("columnheader", { name: "Business Reason" })).toBeInTheDocument();
  });
});

describe("T11 — BatchExpenseLinesTable: amountLabel shown in column header", () => {
  it("renders amountLabel prop as column header", () => {
    render(React.createElement(BatchExpenseLinesTable, TABLE_BASE_PROPS));
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument();
  });
});

describe("T12 — BatchExpenseLinesTable: placeholder uses titleLabel when not required", () => {
  it("placeholder equals titleLabel when titleRequired=false", () => {
    render(React.createElement(BatchExpenseLinesTable, { ...TABLE_BASE_PROPS, titleRequired: false }));
    const input = screen.getByPlaceholderText("Heading");
    expect(input).toBeInTheDocument();
  });
});

describe("T13 — BatchExpenseLinesTable: placeholder appends * when titleRequired=true", () => {
  it("placeholder is 'Heading *' when titleRequired=true", () => {
    render(React.createElement(BatchExpenseLinesTable, { ...TABLE_BASE_PROPS, titleRequired: true }));
    const input = screen.getByPlaceholderText("Heading *");
    expect(input).toBeInTheDocument();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T14–T15  validateBatchLines — category + purpose label in error
// ═════════════════════════════════════════════════════════════════════════════

describe("T14 — validateBatchLines: category label uses configured label in error", () => {
  it("error says 'Expense Type' not 'Category' when custom label set", () => {
    const cfg = makeConfig("category", { label: "Expense Type", is_required: true, is_visible: true });
    const result = validateBatchLines([makeLine({ category: "" }), makeLine({ category: "" })], cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Expense Type");
    }
  });
});

describe("T15 — validateBatchLines: purpose label uses configured label in error", () => {
  it("error says 'Business Reason' not 'Purpose' when custom label set", () => {
    const cfg = makeConfig("purpose", { label: "Business Reason", is_required: true, is_visible: true });
    const result = validateBatchLines([makeLine({ purpose: "" }), makeLine({ purpose: "" })], cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Business Reason");
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// T16–T22  Runtime parity fix (RC) — end-to-end label flow + remaining surfaces
// ═════════════════════════════════════════════════════════════════════════════

describe("T16 — 'Purpose / Title' custom label flows end-to-end through resolve+translate", () => {
  it("resolveBaseFieldConfig + translateBaseFieldConfig preserves 'Purpose / Title'", () => {
    const rows = [{ field_key: "title", label: "Purpose / Title", is_required: true, is_visible: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translated = translateBaseFieldConfig(cfg, mockT as any);
    expect(translated.title.label).toBe("Purpose / Title");
    // canonical key remains "title" — not renamed
    expect(translated.title.field_key).toBe("title");
  });
});

describe("T17 — validateBatchLines: 'Purpose / Title is required' in error message", () => {
  it("validation error says 'Purpose / Title is required', not bare 'Title is required'", () => {
    const rows = [{ field_key: "title", label: "Purpose / Title", is_required: true, is_visible: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    const result = validateBatchLines([makeLine({ title: "" }), makeLine({ title: "" })], cfg);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Message is "Line 1: Purpose / Title is required" — uses configured label
      expect(result.message).toContain("Purpose / Title");
      // The old hardcoded Zod message was the bare "Title is required" (no "Line N:" prefix)
      // The new message always starts with "Line N:" so it cannot be the bare Zod string
      expect(result.message).toMatch(/^Line \d+:/);
    }
  });
});

describe("T18 — BatchExpenseLinesTable: purpose placeholder uses purposeLabel", () => {
  it("renders purposeLabel as textarea placeholder when purpose shown", () => {
    render(React.createElement(BatchExpenseLinesTable, TABLE_BASE_PROPS));
    const textarea = screen.getByPlaceholderText("Business Reason");
    expect(textarea).toBeInTheDocument();
  });
});

describe("T19 — BatchExpenseLinesTable: destination placeholder uses destinationLabel", () => {
  it("renders destinationLabel as input placeholder in per-line table", () => {
    const props = {
      ...TABLE_BASE_PROPS,
      showDestination: true,
      sharedDestination: "",
      destinationLabel: "Customer Site",
    };
    render(React.createElement(BatchExpenseLinesTable, props));
    const input = screen.getByPlaceholderText("Customer Site");
    expect(input).toBeInTheDocument();
  });
});

describe("T20 — BatchExpenseLinesTable: default config renders 'Title' column header", () => {
  it("shows 'Title' in header when titleLabel is the DEFAULT 'Title'", () => {
    const props = { ...TABLE_BASE_PROPS, titleLabel: "Title" };
    render(React.createElement(BatchExpenseLinesTable, props));
    // No sharedTitle passed → title column rendered
    expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
  });
});

describe("T21 — BatchExpenseLinesTable: destination column header uses destinationLabel", () => {
  it("renders custom destinationLabel 'Customer Site' as column header", () => {
    const props = {
      ...TABLE_BASE_PROPS,
      showDestination: true,
      sharedDestination: "",
      destinationLabel: "Customer Site",
    };
    render(React.createElement(BatchExpenseLinesTable, props));
    expect(screen.getByRole("columnheader", { name: "Customer Site" })).toBeInTheDocument();
  });
});

describe("T22 — resolveBaseFieldConfig: canonical field_key is 'title', never renamed", () => {
  it("field_key stays 'title' even after applying custom label", () => {
    const rows = [{ field_key: "title", label: "Purpose / Title", is_required: false, is_visible: true }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = resolveBaseFieldConfig(rows as any);
    expect(cfg.title.field_key).toBe("title");
    expect(cfg.title.label).toBe("Purpose / Title");
  });
});
